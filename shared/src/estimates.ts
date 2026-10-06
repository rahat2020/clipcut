import type { StageName, StageStatus } from "./enums";

/**
 * "About 3 min left" on the video page. Rough on purpose: each stage's typical time for a
 * video of this length, measured in dev on 2026-09-30 (an 8.5-min Bangla YouTube video:
 * download 61 s at ~0.5 MB/s, audio 34 s, Gemini transcription 104 s in two batches,
 * clip selection 32 s). Pure and client-safe (no Node or database imports).
 *
 * Render (Step 12): the top 3 clips, ~20–40 s each to encode and upload, whatever the
 * video's length. Copy is skipped until Step 15.
 */

const MIN = 60_000;

export function expectedStageMs(stage: StageName, mediaMs: number): number | null {
  const minutes = Math.max(mediaMs, 0) / MIN;
  switch (stage) {
    case "ingest":
      // 1080p since Step 12 (~2.5× the bytes of 720p); a running download reports its own time left.
      return 15_000 + minutes * 12_000;
    case "audio":
      return 10_000 + minutes * 3_000;
    case "transcribe":
      // 5-min batches, two at a time: ~60 s per 10 min of audio, plus the language check.
      return 30_000 + Math.ceil(minutes / 10) * 60_000;
    case "analyze":
      return 20_000 + minutes * 2_500;
    case "copy":
      return 0;
    case "render":
      return 20_000 + 3 * 30_000;
  }
}

type StageState = { status: StageStatus; startedAt?: Date | string | null };

export type RemainingEstimate = {
  remainingMs: number;
  /** The running stage has taken more than twice its usual time. */
  slow: boolean;
};

/**
 * Time left for a queued or processing video, or null when the video's length isn't known
 * yet. A running download that reports its own time left (`downloadEtaSec`) uses that.
 */
export function estimateRemainingMs(args: {
  stages: Partial<Record<StageName, StageState | null>>;
  mediaMs: number | null;
  now: number;
  downloadEtaSec?: number | null;
}): RemainingEstimate | null {
  if (!args.mediaMs) return null;
  let remainingMs = 0;
  let slow = false;
  for (const [name, state] of Object.entries(args.stages) as [StageName, StageState | null][]) {
    const expected = expectedStageMs(name, args.mediaMs);
    if (expected === null || !state) continue;
    if (state.status === "pending") remainingMs += expected;
    if (state.status !== "running") continue;
    if (name === "ingest" && args.downloadEtaSec != null) {
      remainingMs += args.downloadEtaSec * 1000 + 15_000;
      continue;
    }
    const elapsed = state.startedAt ? args.now - new Date(state.startedAt).getTime() : 0;
    if (elapsed > expected * 2) slow = true;
    remainingMs += Math.max(expected - elapsed, 10_000);
  }
  return { remainingMs, slow };
}
