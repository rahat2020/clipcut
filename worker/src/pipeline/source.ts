import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { downloadPrivateFile } from "../services/storage/cloudinary";
import type { TransferStats } from "../lib/transfer";
import { downloadYouTube } from "../services/media/ytdlp";
import { AppError, getSettings } from "../shared";
import type { StageContext } from "./stages/types";

/** Marks a complete local source: written only after the download fully succeeded. */
const MARKER = "source.ready";

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    (s) => s.isFile() && s.size > 0,
    () => false,
  );
}

/** True when this job already has the source on disk (ingest ran in the same job). */
export async function hasLocalSource(ctx: Pick<StageContext, "scratchDir">): Promise<boolean> {
  const known = await readFile(path.join(ctx.scratchDir, MARKER), "utf8").catch(() => null);
  return !!known && (await exists(path.join(ctx.scratchDir, known)));
}

/**
 * The source video as a local file in this job's scratch folder, downloading it if it
 * isn't there yet. Every stage that needs the video calls this — so a stage that runs in
 * a fresh job (retry after a crash, user retry) fetches it again instead of assuming an
 * earlier stage left it behind.
 *
 * `fraction` callbacks cover only the download; the caller maps them into its stage.
 * While downloading, the transfer (bytes, speed, time left) is shown to the user as
 * `pipeline.activity`.
 */
export async function ensureSource(ctx: StageContext, onProgress?: (fraction: number) => void): Promise<string> {
  const kind = ctx.video.source.type === "youtube" ? "download_youtube" : "download_upload";
  const report = (fraction: number, transfer?: TransferStats) => {
    onProgress?.(fraction);
    if (transfer) void ctx.run.reportActivity({ kind, ...transfer }).catch(() => {});
  };
  const marker = path.join(ctx.scratchDir, MARKER);
  const known = await readFile(marker, "utf8").catch(() => null);
  if (known && (await exists(path.join(ctx.scratchDir, known)))) return path.join(ctx.scratchDir, known);

  const { source } = ctx.video;
  let file: string;
  const t0 = Date.now();

  if (source.type === "upload") {
    const publicId = source.cloudinary?.publicId;
    if (!publicId) throw new AppError("UPLOAD_NOT_FOUND");
    const format = source.cloudinary?.format || "mp4";
    file = path.join(ctx.scratchDir, `source.${format}`);
    let bytes: number | null;
    try {
      bytes = await downloadPrivateFile({ publicId, format, dest: file, signal: ctx.run.signal, onProgress: report });
    } catch (cause) {
      if (ctx.run.signal.aborted) throw cause;
      throw new AppError("STORAGE_FAILED", { message: "We couldn't read your uploaded video. We'll retry.", cause });
    }
    if (bytes === null) throw new AppError("UPLOAD_NOT_FOUND");
  } else if (source.type === "youtube") {
    if (!source.externalId) throw new AppError("UNSUPPORTED_SOURCE");
    const { render } = await getSettings("system");
    file = await downloadYouTube({
      maxHeight: render.youtubeMaxHeight,
      videoId: source.externalId,
      dir: ctx.scratchDir,
      durationMs: ctx.video.media?.durationMs ?? null,
      signal: ctx.run.signal,
      onProgress: report,
    });
  } else {
    throw new AppError("UNSUPPORTED_SOURCE");
  }

  await ctx.run.clearActivity();
  await writeFile(marker, path.basename(file));
  ctx.log.info({ file: path.basename(file), ms: Date.now() - t0 }, "source downloaded");
  return file;
}
