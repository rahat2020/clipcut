import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "pino";
import type { Types } from "mongoose";

import { ToolError } from "../lib/exec";
import type { Word } from "../services/clips/lines";
import { buildAss, buildPhrases, clipWords, wordsFromSegments } from "../services/render/captions";
import { encodeClip, extractCoverFrames, prepareFonts } from "../services/render/encode";
import { probeMedia } from "../services/media/ffprobe";
import { coverFramePublicId, readPrivateJson, renderPublicId, uploadPrivateImage, uploadPrivateVideo } from "../services/storage/cloudinary";
import {
  AppError,
  captionStyle,
  Clip,
  getSettings,
  isAppError,
  isDuplicateKeyError,
  UsageEvent,
  Video,
  type RenderSpec,
  type TranscriptDoc,
} from "../shared";
import type { RenderHandle } from "./store";

/**
 * One render, start to finish: captions → encode → upload → mark ready. Shared by the
 * pipeline's auto-render (stages/render.ts) and the render queue (processors/render-processor.ts);
 * they differ only in where the source comes from.
 */

type TranscriptForCaptions = Pick<TranscriptDoc, "segments" | "words">;

/** Word timings for captions; without the word file (read failed) the segments are spread out instead. */
export async function loadCaptionWords(transcript: TranscriptForCaptions, log: Logger): Promise<Word[]> {
  const publicId = transcript.words?.publicId;
  if (publicId) {
    const file = await readPrivateJson<{ words?: Word[] }>(publicId).catch((err: unknown) => {
      log.warn({ err }, "couldn't read word timestamps — captions from segments");
      return null;
    });
    if (file?.words?.length) return file.words;
  }
  return wordsFromSegments(transcript.segments);
}

export function toAppError(err: unknown): AppError {
  if (isAppError(err)) return err;
  if (err instanceof ToolError) return new AppError("FFMPEG_FAILED", { cause: err });
  return new AppError("INTERNAL", { cause: err });
}

export async function produceRender(args: {
  handle: RenderHandle;
  video: { _id: Types.ObjectId; userId: Types.ObjectId };
  clipId: Types.ObjectId;
  spec: RenderSpec;
  words: readonly Word[];
  /** The source file and where it starts in the original video (a downloaded section starts later). */
  input: { file: string; startMs: number; fps: number | null; hasAudio: boolean };
  workDir: string;
  signal?: AbortSignal;
  log: Logger;
  onProgress?: (fraction: number) => void;
}): Promise<void> {
  const { handle, spec, workDir, log } = args;
  const report = (f: number) => {
    handle.progress(f);
    args.onProgress?.(f);
  };
  const style = captionStyle(spec.captionStyleId);
  const durationMs = spec.endMs - spec.startMs;
  const assName = `captions-${handle.id}.ass`;
  const output = path.join(workDir, `render-${handle.id}.mp4`);
  const { render: cfg } = await getSettings("system");

  await prepareFonts(workDir);
  const phrases = spec.burnCaptions ? buildPhrases(clipWords(args.words, spec.startMs, spec.endMs), style, durationMs) : [];
  if (phrases.length > 0) await writeFile(path.join(workDir, assName), buildAss(phrases, style, spec), "utf8");

  try {
    const t0 = Date.now();
    try {
      await encodeClip({
        input: args.input.file,
        output,
        inputStartMs: Math.max(spec.startMs - args.input.startMs, 0),
        durationMs,
        aspect: spec.aspectRatio,
        width: spec.width,
        height: spec.height,
        cropOffsetX: spec.cropOffsetX,
        workDir,
        assFile: phrases.length > 0 ? assName : null,
        sourceFps: args.input.fps,
        requireAudio: args.input.hasAudio,
        crf: cfg.crf,
        preset: cfg.preset,
        signal: args.signal,
        onProgress: (f) => report(0.1 + f * 0.75),
      });
    } catch (err) {
      if (err instanceof ToolError && err.reason === "aborted") throw err;
      throw new AppError("FFMPEG_FAILED", { message: "We couldn't render this clip.", cause: err });
    }
    const encodeMs = Date.now() - t0;
    // Never store a clip that lost its sound or came out the wrong size.
    const made = await probeMedia(output, args.signal);
    if ((args.input.hasAudio && !made.hasAudio) || made.width !== spec.width || made.height !== spec.height) {
      log.warn({ made, expectAudio: args.input.hasAudio }, "rendered file failed its check");
      throw new AppError("FFMPEG_FAILED", { message: "The rendered clip came out wrong (missing sound or size). Try again." });
    }
    report(0.85);

    const publicId = renderPublicId(String(args.video.userId), String(args.video._id), handle.id);
    let uploaded;
    try {
      uploaded = await uploadPrivateVideo(output, publicId);
    } catch (cause) {
      throw new AppError("STORAGE_FAILED", { message: "We couldn't save the rendered clip. Try again.", cause });
    }
    const covers = await makeCoverFrames(args, publicId, log);
    await handle.finish({ publicId, ...uploaded }, encodeMs, covers);
    log.info({ renderId: handle.id, clipId: String(args.clipId), encodeMs, bytes: uploaded.bytes, phrases: phrases.length }, "clip rendered");

    await Promise.all([
      Clip.updateOne({ _id: args.clipId }, { $set: { "signals.rendered": true, latestRenderId: handle._id } }),
      Video.updateOne({ _id: args.video._id }, { $inc: { "counts.renders": 1 } }),
      UsageEvent.create({
        userId: args.video.userId,
        videoId: args.video._id,
        type: "render",
        quantity: 1,
        unit: "count",
        idempotencyKey: `render:${handle.id}`,
      }).catch((err: unknown) => {
        if (!isDuplicateKeyError(err)) log.warn({ err }, "couldn't record render usage");
      }),
    ]);
    report(1);
  } finally {
    await Promise.all([rm(output, { force: true }), rm(path.join(workDir, assName), { force: true })]);
  }
}

/**
 * Cover candidates (Step 15.5): clean frames of the clip, uploaded next to the MP4. Nice to
 * have — any failure is logged and the render still succeeds, just without covers.
 */
async function makeCoverFrames(args: Parameters<typeof produceRender>[0], renderId: string, log: Logger): Promise<string[]> {
  const { spec } = args;
  const dir = path.join(args.workDir, `covers-${args.handle.id}`);
  try {
    await mkdir(dir, { recursive: true });
    const files = await extractCoverFrames({
      input: args.input.file,
      inputStartMs: Math.max(spec.startMs - args.input.startMs, 0),
      durationMs: spec.endMs - spec.startMs,
      aspect: spec.aspectRatio,
      width: spec.width,
      height: spec.height,
      cropOffsetX: spec.cropOffsetX,
      workDir: dir,
      signal: args.signal,
    });
    const ids = files.map((_, i) => coverFramePublicId(renderId, i + 1));
    await Promise.all(files.map((f, i) => uploadPrivateImage(path.join(dir, f), ids[i]!)));
    return ids;
  } catch (err) {
    if (args.signal?.aborted) throw err;
    log.warn({ err, renderId: args.handle.id }, "couldn't make cover frames — the render is fine without them");
    return [];
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
