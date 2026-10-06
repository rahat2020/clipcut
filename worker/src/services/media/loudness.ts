import { env } from "../../config/env";
import { runTool } from "../../lib/exec";

/**
 * How loud the audio is every 20 ms, so clip cuts can land in real quiet (Step 10).
 *
 * Needed because Whisper's word timestamps can't show pauses: in real transcripts ~90 % of
 * words end exactly where the next one starts (Whisper stretches each word over the pause
 * after it). The audio itself shows where the speaker actually stopped.
 *
 * The stored Opus audio is decoded to 8 kHz mono PCM on stdout (never written to disk) and
 * reduced to one dB value per frame: 1 h ≈ 180,000 floats (0.7 MB).
 */

export type Span = { startMs: number; endMs: number };

export type Loudness = {
  frameMs: number;
  /** dBFS per frame; digital silence is -100. */
  db: Float32Array;
  /**
   * Frames at or below this count as quiet (between the noise floor and speech level).
   * Null when the audio has no usable contrast — e.g. music under all the speech.
   */
  quietDb: number | null;
};

export const LOUDNESS_RULES = {
  frameMs: 20,
  sampleRate: 8_000,
  /** Quiet = noise floor + this share of the way up to speech level. */
  quietShare: 0.35,
  /** Noise floor = this percentile of the frames (pauses can be under 10 % of busy speech). */
  floorShare: 0.05,
  /** Speech level = this percentile. */
  speechShare: 0.9,
  /** Less than this between noise floor and speech level → no quiet. */
  minContrastDb: 12,
};

const FLOOR_DB = -100;

export async function measureLoudness(args: { file: string; durationMs: number; signal?: AbortSignal }): Promise<Loudness> {
  const { frameMs, sampleRate } = LOUDNESS_RULES;
  const samplesPerFrame = (sampleRate * frameMs) / 1000;
  const frames: number[] = [];
  let sumSq = 0;
  let count = 0;
  let carry: Buffer | null = null;

  const onBytes = (chunk: Buffer) => {
    let buf = carry ? Buffer.concat([carry, chunk]) : chunk;
    const usable = buf.length - (buf.length % 2);
    carry = usable < buf.length ? buf.subarray(usable) : null;
    buf = buf.subarray(0, usable);
    for (let i = 0; i < buf.length; i += 2) {
      const v = buf.readInt16LE(i) / 32768;
      sumSq += v * v;
      if (++count === samplesPerFrame) {
        frames.push(toDb(sumSq / count));
        sumSq = 0;
        count = 0;
      }
    }
  };

  await runTool(
    env.FFMPEG_PATH,
    [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-i",
      args.file,
      "-map",
      "0:a:0",
      "-vn",
      "-ac",
      "1",
      "-ar",
      String(sampleRate),
      "-f",
      "s16le",
      "-acodec",
      "pcm_s16le",
      "pipe:1",
    ],
    // Decoding runs ~100× real time; generous cap for slow machines.
    { timeoutMs: Math.max(2 * 60_000, args.durationMs / 4), signal: args.signal, onStdoutBytes: onBytes },
  );
  if (count > 0) frames.push(toDb(sumSq / count));

  const db = Float32Array.from(frames);
  return { frameMs, db, quietDb: quietThreshold(db) };
}

function toDb(meanSquare: number): number {
  return meanSquare > 0 ? Math.max(10 * Math.log10(meanSquare), FLOOR_DB) : FLOOR_DB;
}

/**
 * Noise floor and speech level from a 1 dB histogram (5th / 90th percentile; digital
 * silence — padding, a muted intro — left out so it can't drag the floor down). Pure.
 */
export function quietThreshold(db: Float32Array, rules = LOUDNESS_RULES): number | null {
  const bins = new Uint32Array(101);
  let total = 0;
  for (const v of db) {
    if (v <= FLOOR_DB) continue;
    bins[Math.min(Math.max(Math.round(-v), 0), 100)]!++;
    total++;
  }
  if (total === 0) return null;
  // Bin i holds -i dB, so walk from the quietest (-100) up.
  const at = (share: number) => {
    const target = total * share;
    let seen = 0;
    for (let i = 100; i >= 0; i--) {
      seen += bins[i]!;
      if (seen >= target) return -i;
    }
    return 0;
  };
  const floor = at(rules.floorShare);
  const speech = at(rules.speechShare);
  if (speech - floor < rules.minContrastDb) return null;
  return floor + rules.quietShare * (speech - floor);
}

/** Every stretch of quiet frames at least `minMs` long, in time order. */
export function quietRuns(loudness: Loudness, minMs: number): Span[] {
  const { quietDb, frameMs: f, db } = loudness;
  if (quietDb === null) return [];
  const runs: Span[] = [];
  let from = -1;
  for (let i = 0; i <= db.length; i++) {
    const quiet = i < db.length && db[i]! <= quietDb;
    if (quiet && from < 0) from = i;
    if (!quiet && from >= 0) {
      if ((i - from) * f >= minMs) runs.push({ startMs: from * f, endMs: i * f });
      from = -1;
    }
  }
  return runs;
}
