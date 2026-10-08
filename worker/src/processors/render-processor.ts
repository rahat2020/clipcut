import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

import type { Job } from "bullmq";

import { logger } from "../lib/logger";
import { loadCaptionWords, produceRender, toAppError } from "../renders/produce";
import { claimQueuedRender, RenderLostError } from "../renders/store";
import { ensureBanglish } from "../services/copy/banglish";
import { emphasisKeys } from "../services/render/captions";
import { probeMedia } from "../services/media/ffprobe";
import { downloadYouTubeSection } from "../services/media/ytdlp";
import { downloadPrivateFile } from "../services/storage/cloudinary";
import { AppError, Clip, ERROR_SPECS, getSettings, Render, Transcript, Video, type RenderJobData } from "../shared";

export type RenderOutcome = "ready" | "failed" | "skipped" | "abandoned";

/** Seconds of extra video fetched around a YouTube section, so the cut never lands at its very edge. */
const SECTION_PAD_MS = 1_500;
/**
 * YouTube now and then refuses one request (a 403 on a fragment, a dropped connection) and the
 * same download works seconds later (seen 2026-10-02: failed in 7 s, fine on the next try).
 * So a generic download failure is tried again after these waits before the render fails.
 */
const SECTION_RETRY_WAITS_MS = [3_000, 10_000];

/** Runs a YouTube section download, trying a generic failure again (see SECTION_RETRY_WAITS_MS). */
export async function withSectionRetries(download: () => Promise<string>, workDir: string, log: typeof logger): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await download();
    } catch (err) {
      const appErr = toAppError(err);
      // Unavailable, too large, or YouTube blocking us: waiting a few seconds won't change that.
      const generic = appErr.code === "DOWNLOAD_FAILED" && appErr.message === ERROR_SPECS.DOWNLOAD_FAILED.message;
      const wait = SECTION_RETRY_WAITS_MS[attempt];
      if (!generic || wait === undefined) throw err;
      log.warn({ attempt: attempt + 1, cause: appErr.cause }, "YouTube section download failed — trying again");
      // A half-written file would make yt-dlp think it's already done.
      for (const f of await readdir(workDir).catch(() => [] as string[])) {
        if (f.startsWith("section.")) await rm(path.join(workDir, f), { force: true });
      }
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

function parseJobData(data: unknown): RenderJobData | null {
  const d = data as Partial<RenderJobData> | null;
  if (d?.v !== 1 || typeof d.renderId !== "string" || !/^[a-f0-9]{24}$/.test(d.renderId) || typeof d.queuedAt !== "number") return null;
  return { v: 1, renderId: d.renderId, queuedAt: d.queuedAt };
}

/**
 * One render the user asked for (the "Render" button). The pipeline renders its top clips
 * itself with the source it already has; here the source is fetched again — the uploaded
 * file from Cloudinary, or just this clip's part of a YouTube video.
 */
export async function processRenderJob(job: Job<RenderJobData>, deps: { scratchRoot: string }): Promise<RenderOutcome> {
  const data = parseJobData(job.data);
  if (!data) return "skipped";
  const log = logger.child({ renderId: data.renderId, jobId: job.id });

  const handle = await claimQueuedRender(data.renderId, new Date(data.queuedAt));
  if (!handle) {
    log.info("render no longer queued — skipped");
    return "skipped";
  }
  handle.startHeartbeat();
  const workDir = path.join(deps.scratchRoot, `render-${data.renderId}`);

  try {
    await mkdir(workDir, { recursive: true });
    const render = await Render.findById(handle._id).lean();
    if (!render) throw new RenderLostError(handle.id);
    const [clip, video] = await Promise.all([
      Clip.findOne({ _id: render.clipId, deletedAt: null }).select({ _id: 1 }).lean(),
      Video.findOne({ _id: render.videoId, deletedAt: null }).lean(),
    ]);
    if (!clip || !video) throw new AppError("NOT_FOUND", { message: "This clip was deleted." });
    if (video.retention?.assetsDeletedAt) throw new AppError("MEDIA_EXPIRED");

    // Renders queued before render@3 have no emphasis / autoZoom: they render as they were asked.
    const spec = { ...render.spec, transcriptVersion: render.spec.transcriptVersion ?? 1, emphasis: render.spec.emphasis ?? [], autoZoom: render.spec.autoZoom === true };
    const transcript =
      (await Transcript.findOne({ videoId: video._id, version: spec.transcriptVersion }).select({ segments: 1, words: 1 }).lean()) ??
      (await Transcript.findOne({ _id: video.currentTranscriptId, videoId: video._id }).select({ segments: 1, words: 1 }).lean());
    if (!transcript) throw new AppError("INTERNAL", { message: "The transcript is missing." });
    let words = await loadCaptionWords(transcript, log);
    const emphasis = emphasisKeys(words, spec); // on the original words — Banglish keeps the times
    // Banglish captions: the words a trim added may not be spelled yet.
    if (spec.captionScript === "Latn" && video.language === "bn") {
      words = (await ensureBanglish({ transcriptId: transcript._id, words, stretches: [spec], log })).words;
    }

    let input: { file: string; startMs: number; fps: number | null; hasAudio: boolean };
    if (video.source.type === "youtube") {
      if (!video.source.externalId) throw new AppError("UNSUPPORTED_SOURCE");
      const { render: cfg } = await getSettings("system");
      const startMs = Math.max(spec.startMs - SECTION_PAD_MS, 0);
      const wantAudio = video.media?.hasAudio !== false;
      const fetchSection = () =>
        withSectionRetries(
          () =>
            downloadYouTubeSection({
              videoId: video.source.externalId!,
              dir: workDir,
              startMs,
              endMs: spec.endMs + SECTION_PAD_MS,
              maxHeight: cfg.youtubeMaxHeight,
            }),
          workDir,
          log,
        );
      let file = await fetchSection();
      let probe = await probeMedia(file);
      // YouTube now and then hands over the picture without the sound; one more try, then give up loudly.
      if (wantAudio && !probe.hasAudio) {
        log.warn({ probe }, "YouTube section came without sound — downloading again");
        await rm(file, { force: true });
        file = await fetchSection();
        probe = await probeMedia(file);
        if (!probe.hasAudio) {
          throw new AppError("DOWNLOAD_FAILED", { message: "We couldn't get this clip's sound from YouTube. Try again in a few minutes." });
        }
      }
      input = { file, startMs, fps: probe.fps, hasAudio: wantAudio };
    } else {
      const publicId = video.source.cloudinary?.publicId;
      if (!publicId) throw new AppError("UPLOAD_NOT_FOUND");
      const format = video.source.cloudinary?.format || "mp4";
      const file = path.join(workDir, `source.${format}`);
      let bytes: number | null;
      try {
        bytes = await downloadPrivateFile({ publicId, format, dest: file });
      } catch (cause) {
        throw new AppError("STORAGE_FAILED", { message: "We couldn't read the source video. Try again.", cause });
      }
      if (bytes === null) throw new AppError("MEDIA_EXPIRED");
      input = { file, startMs: 0, fps: video.media?.fps ?? null, hasAudio: video.media?.hasAudio !== false };
    }
    handle.progress(0.1);

    await produceRender({ handle, video, clipId: render.clipId, spec, words, emphasis, input, workDir, log });
    return "ready";
  } catch (err) {
    if (err instanceof RenderLostError) {
      log.info("render taken over or deleted — stopped without writing");
      return "abandoned";
    }
    const appErr = toAppError(err);
    if (appErr.code === "INTERNAL") log.error({ err }, "render failed with an unexpected error");
    else log.warn({ code: appErr.code, cause: appErr.cause }, "render failed");
    await handle.fail(appErr).catch(() => {});
    return "failed";
  } finally {
    handle.stop();
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
