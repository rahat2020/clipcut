import { readdir } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { env } from "../../config/env";
import { runTool, ToolError } from "../../lib/exec";
import { TransferMeter, type TransferStats } from "../../lib/transfer";
import { AppError } from "../../shared";

/**
 * YouTube via yt-dlp. The URL is rebuilt here from the 11-character video id, so nothing
 * the user typed ever reaches the command line.
 *
 * `--js-runtimes node`: current YouTube needs a JavaScript runtime to list all formats;
 * yt-dlp only looks for Deno by default, and Node is always present in the worker.
 */

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * Best video up to `maxHeight` (≤ 30 fps preferred, H.264 preferred so no re-encode is
 * needed) + best audio, falling back step by step. 1080p by default (settings
 * `system.render.youtubeMaxHeight`): a 9:16 crop of 720p is only 405 px wide and looks soft
 * once scaled to 1080 × 1920.
 */
export function youtubeFormat(maxHeight: number): string {
  const h = `[height<=${maxHeight}]`;
  return (
    `bv*${h}[fps<=30][vcodec^=avc1]+ba[ext=m4a]/bv*${h}[vcodec^=avc1]+ba[ext=m4a]/` + `bv*${h}+ba/b${h}/b`
  );
}

export function youtubeUrl(videoId: string): string {
  if (!YOUTUBE_ID.test(videoId)) throw new AppError("UNSUPPORTED_SOURCE");
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function baseArgs(): string[] {
  const args = [
    "--ignore-config",
    "--no-playlist",
    "--no-cache-dir", // default cache lives on C:
    "--js-runtimes",
    `node:${process.execPath}`,
    "--socket-timeout",
    "30",
    "--retries",
    "3",
    "--fragment-retries",
    "3",
  ];
  // yt-dlp finds ffmpeg on PATH; point it at ours when the env gives a full path.
  if (path.isAbsolute(env.FFMPEG_PATH)) args.push("--ffmpeg-location", env.FFMPEG_PATH);
  return args;
}

/**
 * yt-dlp's stderr → an error the user can act on. Anything we don't recognise is a
 * retryable download failure.
 */
export function mapYtDlpError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const text = err instanceof ToolError ? err.stderrTail : String(err);
  const unavailable =
    /private video|video unavailable|this video is (?:not |un)available|not available in your country|has been removed|members[- ]only|join this channel|confirm your age|age[- ]restricted|inappropriate|copyright|account.*terminated|premieres in/i;
  if (unavailable.test(text)) return new AppError("VIDEO_UNAVAILABLE", { cause: err });
  if (/larger than max-filesize/i.test(text)) return new AppError("FILE_TOO_LARGE", { cause: err });
  if (/confirm you.?re not a bot/i.test(text)) {
    return new AppError("DOWNLOAD_FAILED", {
      message: "YouTube is blocking downloads right now. Try again later, or upload the file instead.",
      cause: err,
    });
  }
  return new AppError("DOWNLOAD_FAILED", { cause: err });
}

const infoSchema = z.looseObject({
  id: z.string(),
  title: z.string().optional(),
  duration: z.number().nullable().optional(),
  live_status: z.string().nullable().optional(),
  is_live: z.boolean().nullable().optional(),
  availability: z.string().nullable().optional(),
  age_limit: z.number().nullable().optional(),
});

export type YouTubeInfo = {
  id: string;
  title: string | null;
  durationMs: number | null;
  liveStatus: string | null;
  availability: string | null;
  ageLimit: number;
};

/** Metadata only (no download): used to reject live streams, long videos etc. before downloading. */
export async function probeYouTube(videoId: string, signal?: AbortSignal): Promise<YouTubeInfo> {
  try {
    const { stdout } = await runTool(env.YTDLP_PATH, [...baseArgs(), "-J", "--", youtubeUrl(videoId)], {
      timeoutMs: 90_000,
      signal,
    });
    const info = infoSchema.parse(JSON.parse(stdout));
    return {
      id: info.id,
      title: info.title ?? null,
      durationMs: info.duration ? Math.round(info.duration * 1000) : null,
      liveStatus: info.live_status ?? (info.is_live ? "is_live" : null),
      availability: info.availability ?? null,
      ageLimit: info.age_limit ?? 0,
    };
  } catch (err) {
    if (err instanceof ToolError && err.reason === "aborted") throw err;
    throw mapYtDlpError(err);
  }
}

/** Largest download we accept (1080p H.264 runs ~1.5–2.5 GB for 3 hours). */
const MAX_DOWNLOAD = "4G";

/**
 * Downloads to `<dir>/source.<ext>` and returns the file path. Progress is reported per
 * stream (video, then audio), folded into one 0..1 value assuming two streams.
 */
export async function downloadYouTube(args: {
  videoId: string;
  dir: string;
  durationMs: number | null;
  maxHeight: number;
  signal?: AbortSignal;
  /** `transfer` describes the stream being downloaded right now (video, then audio). */
  onProgress?: (fraction: number, transfer?: TransferStats) => void;
}): Promise<string> {
  const { videoId, dir, signal, onProgress } = args;
  let stream = 0;
  let lastBytes = 0;
  const meter = new TransferMeter();
  const onLine = (line: string) => {
    const m = /^PROG (\d+) (\S+) (\S+)/.exec(line);
    if (!m) return;
    const done = Number(m[1]);
    const total = Number(m[2]) || Number(m[3]);
    if (done < lastBytes) stream = Math.min(stream + 1, 1); // next stream started
    lastBytes = done;
    if (total > 0) onProgress?.(Math.min((stream + done / total) / 2, 0.99), meter.update(done, total));
  };

  try {
    await runTool(
      env.YTDLP_PATH,
      [
        ...baseArgs(),
        "-f",
        youtubeFormat(args.maxHeight),
        "--merge-output-format",
        "mp4",
        "--max-filesize",
        MAX_DOWNLOAD,
        "--no-mtime",
        "--no-part",
        "--newline",
        "--progress",
        "--progress-template",
        "download:PROG %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s",
        "-o",
        path.join(dir, "source.%(ext)s"),
        "--",
        youtubeUrl(videoId),
      ],
      {
        // Slow links (dev ~0.5 MB/s) need time; a stalled download is still cut off.
        timeoutMs: Math.max(20 * 60_000, (args.durationMs ?? 0) * 1.5),
        signal,
        captureStdout: false,
        onStdoutLine: onLine,
        onStderrLine: onLine,
      },
    );
  } catch (err) {
    if (err instanceof ToolError && err.reason === "aborted") throw err;
    throw mapYtDlpError(err);
  }

  const file = (await readdir(dir)).find((f) => /^source\.(mp4|mkv|webm)$/.test(f));
  if (!file) throw new AppError("DOWNLOAD_FAILED", { message: "The download finished but no video file was found." });
  onProgress?.(1);
  return path.join(dir, file);
}

/**
 * Downloads only [startMs, endMs] of a YouTube video to `<dir>/section.mp4` — for a clip
 * rendered after the pipeline finished (YouTube sources are never stored). Cuts are made
 * exact (`--force-keyframes-at-cuts` re-encodes around them), so the file starts at startMs.
 */
export async function downloadYouTubeSection(args: {
  videoId: string;
  dir: string;
  startMs: number;
  endMs: number;
  maxHeight: number;
  signal?: AbortSignal;
}): Promise<string> {
  const range = `*${(args.startMs / 1000).toFixed(3)}-${(args.endMs / 1000).toFixed(3)}`;
  try {
    await runTool(
      env.YTDLP_PATH,
      [
        ...baseArgs(),
        "-f",
        youtubeFormat(args.maxHeight),
        "--download-sections",
        range,
        "--force-keyframes-at-cuts",
        "--merge-output-format",
        "mp4",
        "--no-mtime",
        "--no-part",
        "-o",
        path.join(args.dir, "section.%(ext)s"),
        "--",
        youtubeUrl(args.videoId),
      ],
      { timeoutMs: Math.max(10 * 60_000, (args.endMs - args.startMs) * 20), signal: args.signal, captureStdout: false },
    );
  } catch (err) {
    if (err instanceof ToolError && err.reason === "aborted") throw err;
    throw mapYtDlpError(err);
  }
  const file = (await readdir(args.dir)).find((f) => /^section.(mp4|mkv|webm)$/.test(f));
  if (!file) throw new AppError("DOWNLOAD_FAILED", { message: "The download finished but no video file was found." });
  return path.join(args.dir, file);
}
