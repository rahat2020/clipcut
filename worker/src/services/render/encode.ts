import { cp, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { env } from "../../config/env";
import { runTool } from "../../lib/exec";
import type { AspectRatio } from "../../shared";

/** Caption fonts shipped with the worker (OFL; see assets/fonts/OFL.txt). */
export const FONTS_DIR = fileURLToPath(new URL("../../../assets/fonts", import.meta.url));

/** Copies the caption fonts next to the job's files, so ffmpeg gets a short relative `fontsdir`. */
export async function prepareFonts(workDir: string): Promise<void> {
  await mkdir(workDir, { recursive: true });
  await cp(FONTS_DIR, path.join(workDir, "fonts"), { recursive: true });
}

const RATIO: Record<AspectRatio, [number, number]> = { "9:16": [9, 16], "1:1": [1, 1], "16:9": [16, 9] };

/**
 * The crop as ffmpeg expressions on the DECODED frame (`iw`/`ih` are after rotation, so
 * phone videos with a rotate flag crop correctly): the biggest box of the target shape,
 * centred vertically, moved sideways by `offsetX` (-1 … 1). Even sizes for yuv420p.
 */
export function cropFilter(aspect: AspectRatio, offsetX: number): string {
  const [a, b] = RATIO[aspect];
  const off = Math.min(Math.max(offsetX, -1), 1).toFixed(3);
  const w = `trunc(min(iw,ih*${a}/${b})/2)*2`;
  const h = `trunc(min(ih,iw*${b}/${a})/2)*2`;
  return `crop=w='${w}':h='${h}':x='(iw-ow)/2*(1+${off})':y='(ih-oh)/2'`;
}

export type EncodeArgs = {
  /** Source file (absolute path). */
  input: string;
  /** Output .mp4 (absolute path). */
  output: string;
  /** Where the clip starts IN THE INPUT FILE (a downloaded section starts later than 0). */
  inputStartMs: number;
  durationMs: number;
  aspect: AspectRatio;
  width: number;
  height: number;
  cropOffsetX: number;
  /** Folder holding `captions.ass` and `fonts/` — ffmpeg runs here. Null file = no captions. */
  workDir: string;
  assFile: string | null;
  /**
   * The source has sound: map it as required, so a missing track fails the encode instead
   * of silently producing a clip without sound.
   */
  requireAudio: boolean;
  /** Source frame rate; above 30 is reduced to 30 (smaller files, no visible loss for talk). */
  sourceFps: number | null;
  crf: number;
  preset: string;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
};

/** Candidate cover frames per clip (Step 15.5). */
export const COVER_FRAMES = 6;

/**
 * Clean cover candidates for a clip — the same crop as the clip, no captions — as
 * `cover-1.jpg` … in `workDir`. The clip is sampled at 2 fps and cut into COVER_FRAMES
 * stretches; ffmpeg's `thumbnail` filter keeps the most typical frame of each (it skips
 * blurry transition frames). Sampling before the filter keeps its memory small. Returns the
 * file names written.
 */
export async function extractCoverFrames(args: {
  input: string;
  inputStartMs: number;
  durationMs: number;
  aspect: AspectRatio;
  width: number;
  height: number;
  cropOffsetX: number;
  workDir: string;
  signal?: AbortSignal;
}): Promise<string[]> {
  const sampled = Math.max(1, Math.floor((args.durationMs / 1000) * 2));
  const batch = Math.max(1, Math.floor(sampled / COVER_FRAMES));
  const filters = [cropFilter(args.aspect, args.cropOffsetX), "fps=2", `thumbnail=n=${batch}`, `scale=${args.width}:${args.height}:flags=lanczos`, "setsar=1"];
  await runTool(
    env.FFMPEG_PATH,
    [
      "-hide_banner",
      "-nostdin",
      "-y",
      "-loglevel",
      "error",
      "-ss",
      (args.inputStartMs / 1000).toFixed(3),
      "-i",
      args.input,
      "-t",
      (args.durationMs / 1000).toFixed(3),
      "-an",
      "-vf",
      filters.join(","),
      "-fps_mode",
      "vfr",
      "-frames:v",
      String(COVER_FRAMES),
      "-q:v",
      "3",
      "cover-%d.jpg",
    ],
    { cwd: args.workDir, timeoutMs: Math.max(2 * 60_000, args.durationMs * 5), signal: args.signal, captureStdout: false },
  );
  return (await readdir(args.workDir)).filter((f) => /^cover-\d+\.jpg$/.test(f)).sort((a, b) => parseInt(a.slice(6)) - parseInt(b.slice(6)));
}

/**
 * One clip: seek → crop → scale → captions → H.264 + AAC MP4 (faststart, so it plays while
 * downloading). Input seeking (`-ss` before `-i`) is frame-accurate when re-encoding and
 * starts the output clock at 0 — the ASS times are relative to the clip start to match.
 */
export async function encodeClip(args: EncodeArgs): Promise<void> {
  const filters = [cropFilter(args.aspect, args.cropOffsetX), `scale=${args.width}:${args.height}:flags=lanczos`, "setsar=1"];
  if (args.sourceFps && args.sourceFps > 30.5) filters.push("fps=30");
  if (args.assFile) filters.push(`ass=${args.assFile}:fontsdir=fonts:shaping=complex`);

  await runTool(
    env.FFMPEG_PATH,
    [
      "-hide_banner",
      "-nostdin",
      "-y",
      "-ss",
      (args.inputStartMs / 1000).toFixed(3),
      "-i",
      args.input,
      "-t",
      (args.durationMs / 1000).toFixed(3),
      "-map",
      "0:v:0",
      "-map",
      args.requireAudio ? "0:a:0" : "0:a:0?",
      "-vf",
      filters.join(","),
      "-c:v",
      "libx264",
      "-preset",
      args.preset,
      "-crf",
      String(args.crf),
      "-profile:v",
      "high",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ac",
      "2",
      "-ar",
      "48000",
      "-movflags",
      "+faststart",
      "-progress",
      "pipe:1",
      "-nostats",
      args.output,
    ],
    {
      cwd: args.workDir,
      // Encoding 1080×1920 on a small CPU can run slower than real time; stalled runs are still cut off.
      timeoutMs: Math.max(5 * 60_000, args.durationMs * 15),
      signal: args.signal,
      captureStdout: false,
      onStdoutLine: (line) => {
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m && args.durationMs > 0) args.onProgress?.(Math.min(Number(m[1]) / 1000 / args.durationMs, 1));
      },
    },
  );
}
