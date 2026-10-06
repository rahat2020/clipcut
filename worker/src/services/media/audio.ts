import { env } from "../../config/env";
import { runTool } from "../../lib/exec";

/**
 * Groq's free tier accepts audio files up to 25 MB. We aim a little lower and pick the
 * highest bitrate that fits: 48 kbps (plenty for speech) for anything up to ~66 min,
 * lower for longer videos, never below 16 kbps. No chunking needed up to 3 hours.
 */
export const TRANSCRIBE_MAX_BYTES = 24 * 1024 * 1024;
const MAX_KBPS = 48;
const MIN_KBPS = 16;

export function audioBitrateKbps(durationMs: number): number {
  const seconds = Math.max(durationMs / 1000, 1);
  const fits = Math.floor((TRANSCRIBE_MAX_BYTES * 8) / seconds / 1000);
  return Math.max(MIN_KBPS, Math.min(MAX_KBPS, fits));
}

export const AUDIO_FORMAT = "ogg";

/**
 * Source video → mono 16 kHz Opus in Ogg, the input Whisper was trained on (16 kHz) in
 * a codec built for speech. `-map 0:a:0` takes the first audio track only.
 * Progress comes from `-progress pipe:1` (out_time_us=… lines).
 */
export async function extractAudio(args: {
  input: string;
  output: string;
  durationMs: number;
  bitrateKbps: number;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}): Promise<void> {
  const { input, output, durationMs, bitrateKbps, signal, onProgress } = args;
  await runTool(
    env.FFMPEG_PATH,
    [
      "-hide_banner",
      "-nostdin",
      "-y",
      "-i",
      input,
      "-map",
      "0:a:0",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "libopus",
      "-b:a",
      `${bitrateKbps}k`,
      "-application",
      "voip",
      "-f",
      "ogg",
      "-progress",
      "pipe:1",
      "-nostats",
      output,
    ],
    {
      // Audio-only work runs far faster than real time; generous cap for slow machines.
      timeoutMs: Math.max(5 * 60_000, durationMs),
      signal,
      captureStdout: false,
      onStdoutLine: (line) => {
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m && durationMs > 0) onProgress?.(Math.min(Number(m[1]) / 1000 / durationMs, 1));
      },
    },
  );
}
