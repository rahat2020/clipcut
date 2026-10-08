import path from "node:path";

import { loadCaptionWords, produceRender, toAppError } from "../../renders/produce";
import { claimRenderForPipeline, queueRenderForPipeline, RenderLostError, type PipelineClaim } from "../../renders/store";
import { ensureBanglish } from "../../services/copy/banglish";
import { emphasisKeys } from "../../services/render/captions";
import { AppError, Clip, getSettings, renderSpecForClip, specVideo, Transcript, Video } from "../../shared";
import { RunLostError } from "../run";
import { ensureSource, hasLocalSource } from "../source";
import type { StageHandler } from "./types";

/**
 * Render ("Rendering clips", Step 12): the best `system.render.autoRenderTop` clips (3 by
 * default) become 9:16 MP4s with burned-in captions while the source is still on disk.
 * The rest render when the user asks (the render queue, processors/render-processor.ts).
 *
 * One clip failing doesn't fail the video — that clip shows "Try again". Only when every
 * clip failed does the stage fail. A retried stage skips clips already rendered.
 *
 * A later YouTube run (the user's "Find new clips", an admin re-run, a retry in a new job) has
 * no source on disk: the best clips that were never rendered go to the render queue instead,
 * which downloads only each clip's section — not the whole video here. An upload is fetched
 * once and rendered here: the render queue would fetch the whole file once per clip.
 */
export const render: StageHandler = async (ctx) => {
  const { video, run, log } = ctx;
  const { render: cfg } = await getSettings("system");
  if (cfg.autoRenderTop === 0) return "skipped";
  // Set by analyze earlier in this job; read from the database too, in case a stage forgot to pass it on.
  const analysisRunId =
    video.currentAnalysisRunId ?? (await Video.findById(video._id).select({ currentAnalysisRunId: 1 }).lean())?.currentAnalysisRunId;
  if (!analysisRunId) return "skipped";

  const clips = await Clip.find({ videoId: video._id, analysisRunId, deletedAt: null })
    .sort({ rank: 1 })
    .limit(cfg.autoRenderTop)
    .select({ _id: 1, startMs: 1, endMs: 1, edit: 1, "copy.emphasis": 1, latestRenderId: 1 })
    .lean();
  if (clips.length === 0) return "skipped";
  const queueOnly = video.source.type === "youtube" && !(await hasLocalSource(ctx));

  const transcript = await Transcript.findOne({ _id: video.currentTranscriptId, videoId: video._id })
    .select({ version: 1, segments: 1, words: 1 })
    .lean();
  if (!transcript) throw new AppError("INTERNAL", { message: "The transcript is missing." });

  if (queueOnly) {
    const fresh = clips.filter((c) => !c.latestRenderId);
    for (const clip of fresh) {
      const spec = renderSpecForClip(clip, specVideo(video), transcript.version);
      await queueRenderForPipeline({ clipId: clip._id, videoId: video._id, userId: video.userId, spec });
    }
    log.info({ clips: clips.length, queued: fresh.length }, "YouTube source not on disk — top clips sent to the render queue");
    return fresh.length > 0 ? undefined : "skipped";
  }

  const claims: { clip: (typeof clips)[number]; spec: ReturnType<typeof renderSpecForClip>; claim: PipelineClaim }[] = [];
  for (const clip of clips) {
    const spec = renderSpecForClip(clip, specVideo(video), transcript.version);
    const claim = await claimRenderForPipeline({ clipId: clip._id, videoId: video._id, userId: video.userId, spec });
    claims.push({ clip, spec, claim });
  }
  const todo = claims.filter((c) => c.claim.kind === "claimed");
  let ok = claims.filter((c) => c.claim.kind !== "claimed").length;
  log.info({ clips: clips.length, toRender: todo.length, alreadyDoneOrBusy: ok }, "rendering top clips");
  if (todo.length === 0) return;

  let words = await loadCaptionWords(transcript, log);
  const original = words; // emphasis is decided on these — Banglish keeps the times
  if (video.language === "bn" && todo.some((t) => t.spec.captionScript === "Latn")) {
    try {
      words = (await ensureBanglish({ transcriptId: transcript._id, words, stretches: todo.map((t) => t.spec), log, signal: run.signal })).words;
    } catch (err) {
      // No Banglish → no captions in the wrong letters: these renders fail ("Try again"); the video doesn't.
      if (err instanceof RunLostError || run.signal.aborted) throw err;
      const e = toAppError(err);
      log.warn({ code: e.code }, "couldn't spell the captions in Banglish — renders marked failed");
      for (const item of todo) if (item.claim.kind === "claimed") await item.claim.handle.fail(e).catch(() => {});
      return;
    }
  }
  const file = await ensureSource(ctx);
  const input = { file, startMs: 0, fps: video.media?.fps ?? null, hasAudio: video.media?.hasAudio !== false };
  const workDir = path.join(ctx.scratchDir, "render");

  let lastError: AppError | null = null;
  for (const [i, item] of todo.entries()) {
    if (item.claim.kind !== "claimed") continue;
    const { handle } = item.claim;
    handle.startHeartbeat();
    try {
      await produceRender({
        handle,
        video,
        clipId: item.clip._id,
        spec: item.spec,
        words,
        emphasis: emphasisKeys(original, item.spec),
        input,
        workDir,
        signal: run.signal,
        log,
        onProgress: (f) => void run.reportProgress((i + f) / todo.length).catch(() => {}),
      });
      ok++;
    } catch (err) {
      // The run was taken away: leave the render as it is — the render queue's stuck sweep picks it up.
      if (err instanceof RunLostError || run.signal.aborted) throw err;
      if (err instanceof RenderLostError) continue;
      lastError = toAppError(err);
      log.warn({ code: lastError.code, cause: lastError.cause, clipId: String(item.clip._id) }, "clip render failed");
      await handle.fail(lastError).catch(() => {});
    } finally {
      handle.stop();
    }
  }
  if (ok === 0 && lastError) throw lastError;
};
