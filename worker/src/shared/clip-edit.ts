// GENERATED — do not edit. Source: shared/src/clip-edit.ts
// Edit the source, then run: node scripts/sync-shared.mjs

/**
 * Rules for clips the user adjusts (Step 13). Client-safe — the editor uses the same numbers
 * to disable buttons that the API uses to reject a request.
 */

export const CLIP_EDIT = {
  /** Shortest clip a trim may leave. */
  minMs: 3_000,
  /** Longest clip a trim may make (Shorts allow 3 min). */
  maxMs: 180_000,
  /** One press of a trim button moves the edge this far. */
  nudgeMs: 500,
} as const;

/**
 * One-tap reasons on Reject. They land in `clips.feedback.reason` and Admin → Accuracy's
 * "Top rejection reasons" — the plainest signal of where clip picking goes wrong.
 */
export const REJECT_REASONS = ["Boring", "Cut off mid-sentence", "Wrong topic", "Too long", "Too short", "Bad captions"] as const;

/** A range the user may save: inside the video, between the shortest and longest allowed. */
export function isValidClipRange(startMs: number, endMs: number, videoMs: number): boolean {
  const len = endMs - startMs;
  return Number.isInteger(startMs) && Number.isInteger(endMs) && startMs >= 0 && endMs <= videoMs && len >= CLIP_EDIT.minMs && len <= CLIP_EDIT.maxMs;
}
