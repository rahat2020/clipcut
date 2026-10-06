import type { MomentType } from "../../shared";
import type { Line } from "./lines";
import type { MomentProposal } from "./prompt";
import { snapClip, type SnapEndRule, type SnapStartRule, type SnapTrack } from "./snap";

/**
 * The AI's proposals (line ranges) → clips with exact times. Pure, so it's easy to test.
 *
 * What happens here:
 *   1. invalid line numbers are dropped; reversed ranges are swapped
 *   2. too short → add the next line (or the previous one), but never across a long gap
 *      (music, a scene change) and never past the maximum
 *   3. too long → drop lines from the end; one line longer than the maximum is cut
 *   4. with a snap track (Step 10, snap.ts): start and end move to clean boundaries
 *      (sentence ends, pauses) and the cuts land in the quiet around the words
 *   5. best score first; a clip overlapping a better one — or a stretch that's already taken
 *      (clips the user keeps, Step 14) — by more than 30 % is dropped
 *   6. the best `count` are kept and ranked 1…n
 */

export type ResolvedMoment = {
  rank: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  /** The AI's own proposal in ms, before the length fix (kept for evaluation). */
  rawStartMs: number;
  rawEndMs: number;
  startLine: number;
  endLine: number;
  /** 0–1 */
  score: number;
  momentType: MomentType;
  reason: string;
  transcriptText: string;
  /** How the whole-line fit went (step 2–3). */
  fit: { start: "line_start" | "extended"; end: "line_end" | "extended" | "trimmed" | "max_cut" };
  /** Step 4, or null when there was no track or nothing to snap (line times kept). */
  snap: {
    startRule: SnapStartRule;
    endRule: SnapEndRule;
    startClean: boolean;
    endClean: boolean;
    /** Final cut minus the line-fit time. */
    startShiftMs: number;
    endShiftMs: number;
  } | null;
};

export type ResolveStats = {
  proposed: number;
  invalid: number;
  tooShort: number;
  overlapping: number;
  /** Dropped for overlapping an already-taken stretch (Step 14). */
  taken: number;
  overCount: number;
  accepted: number;
  /** Of the accepted clips: how many start / end at a clean boundary (Step 10). */
  cleanStarts: number;
  cleanEnds: number;
};

/** Lines further apart than this aren't joined to reach the minimum length. */
export const MAX_JOIN_GAP_MS = 4_000;
/** Share of the shorter clip two clips may share before the lower-scored one is dropped. */
export const MAX_OVERLAP_SHARE = 0.3;

export function resolveMoments(
  proposals: readonly MomentProposal[],
  lines: readonly Line[],
  opts: {
    minClipMs: number;
    maxClipMs: number;
    count: number;
    track?: SnapTrack | null;
    /** Stretches that already have a clip (Step 14 "Find new clips"); new clips must not repeat them. */
    taken?: readonly { startMs: number; endMs: number }[];
  },
): { moments: ResolvedMoment[]; stats: ResolveStats } {
  const stats: ResolveStats = {
    proposed: proposals.length,
    invalid: 0,
    tooShort: 0,
    overlapping: 0,
    taken: 0,
    overCount: 0,
    accepted: 0,
    cleanStarts: 0,
    cleanEnds: 0,
  };
  if (lines.length === 0) return { moments: [], stats };

  // A video whose whole speech is shorter than the minimum can still give one clip.
  const speechMs = lines.at(-1)!.endMs - lines[0]!.startMs;
  const minMs = Math.min(opts.minClipMs, speechMs);
  const maxMs = Math.max(opts.maxClipMs, minMs);
  const byNumber = new Map(lines.map((l, i) => [l.n, i]));

  const candidates: Omit<ResolvedMoment, "rank">[] = [];
  for (const p of proposals) {
    let a = byNumber.get(p.start_line);
    let b = byNumber.get(p.end_line);
    if (a === undefined || b === undefined) {
      stats.invalid++;
      continue;
    }
    if (a > b) [a, b] = [b, a];
    const fitted = fitLength(lines, a, b, minMs, maxMs);
    if (!fitted) {
      stats.tooShort++;
      continue;
    }
    const { s, e, startRule } = fitted;
    let { endRule } = fitted;
    const lineStartMs = lines[s]!.startMs;
    let lineEndMs = lines[e]!.endMs;
    if (lineEndMs - lineStartMs > maxMs) {
      lineEndMs = lineStartMs + maxMs;
      endRule = "max_cut";
    }
    const snapped = opts.track ? snapClip(opts.track, { startMs: lineStartMs, endMs: lineEndMs }, { minMs, maxMs }) : null;
    const startMs = snapped?.startMs ?? lineStartMs;
    const endMs = snapped?.endMs ?? lineEndMs;
    candidates.push({
      startMs,
      endMs,
      durationMs: endMs - startMs,
      rawStartMs: lines[a]!.startMs,
      rawEndMs: lines[b]!.endMs,
      startLine: lines[s]!.n,
      endLine: lines[e]!.n,
      score: Math.min(Math.max(Math.round(p.score), 0), 100) / 100,
      momentType: p.type,
      reason: p.reason,
      transcriptText:
        snapped?.text ??
        lines
          .slice(s, e + 1)
          .map((l) => l.text)
          .join(" "),
      fit: { start: startRule, end: endRule },
      snap: snapped && {
        startRule: snapped.startRule,
        endRule: snapped.endRule,
        startClean: snapped.startClean,
        endClean: snapped.endClean,
        startShiftMs: startMs - lineStartMs,
        endShiftMs: endMs - lineEndMs,
      },
    });
  }

  // Stable sort: equal scores keep the model's own order (it was asked for best first).
  candidates.sort((x, y) => y.score - x.score);
  const kept: Omit<ResolvedMoment, "rank">[] = [];
  const taken = opts.taken ?? [];
  for (const c of candidates) {
    if (taken.some((t) => overlapShare(t, c) > MAX_OVERLAP_SHARE)) {
      stats.taken++;
      continue;
    }
    if (kept.some((k) => overlapShare(k, c) > MAX_OVERLAP_SHARE)) {
      stats.overlapping++;
      continue;
    }
    if (kept.length >= opts.count) {
      stats.overCount++;
      continue;
    }
    kept.push(c);
  }
  stats.accepted = kept.length;
  stats.cleanStarts = kept.filter((m) => m.snap?.startClean).length;
  stats.cleanEnds = kept.filter((m) => m.snap?.endClean).length;
  return { moments: kept.map((m, i) => ({ ...m, rank: i + 1 })), stats };
}

function fitLength(
  lines: readonly Line[],
  a: number,
  b: number,
  minMs: number,
  maxMs: number,
): { s: number; e: number; startRule: ResolvedMoment["fit"]["start"]; endRule: ResolvedMoment["fit"]["end"] } | null {
  let s = a;
  let e = b;
  let startRule: ResolvedMoment["fit"]["start"] = "line_start";
  let endRule: ResolvedMoment["fit"]["end"] = "line_end";
  const span = () => lines[e]!.endMs - lines[s]!.startMs;

  while (span() < minMs) {
    const next = lines[e + 1];
    if (next && next.startMs - lines[e]!.endMs <= MAX_JOIN_GAP_MS && next.endMs - lines[s]!.startMs <= maxMs) {
      e++;
      endRule = "extended";
      continue;
    }
    const prev = lines[s - 1];
    if (prev && lines[s]!.startMs - prev.endMs <= MAX_JOIN_GAP_MS && lines[e]!.endMs - prev.startMs <= maxMs) {
      s--;
      startRule = "extended";
      continue;
    }
    return null;
  }
  // Drop whole lines while that keeps the minimum; what's left over the maximum gets cut.
  while (span() > maxMs && e > s && lines[e - 1]!.endMs - lines[s]!.startMs >= minMs) {
    e--;
    endRule = "trimmed";
  }
  return { s, e, startRule, endRule };
}

function overlapShare(x: { startMs: number; endMs: number }, y: { startMs: number; endMs: number }): number {
  const overlap = Math.min(x.endMs, y.endMs) - Math.max(x.startMs, y.startMs);
  if (overlap <= 0) return 0;
  return overlap / Math.min(x.endMs - x.startMs, y.endMs - y.startMs);
}
