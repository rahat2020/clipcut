import { quietRuns, type Loudness } from "../media/loudness";
import { SENTENCE_END, wordsBySegment, type Segment, type Word } from "./lines";

/**
 * Boundary snapping (Step 10): the clip the AI picked, cut where a person would cut it.
 * Pure, so it's easy to test.
 *
 * The AI picks whole lines (moments.ts); a line can still start or end mid-sentence (lines
 * are also split at 8–15 s), and cutting exactly at a word timestamp clips the first or
 * last syllable. So, per clip:
 *   1. Every gap between two words gets a strength: clean (sentence end, a real pause, or a
 *      Whisper segment end with a short pause), soft (segment end or short pause only), or
 *      mid-phrase. Pauses come from the AUDIO (loudness.ts) as well as the timestamps:
 *      Whisper makes ~90 % of words touch the next one, so timestamp gaps alone miss them.
 *      Each quiet stretch ≥250 ms in the audio is given to the nearest word boundary (within
 *      0.4 s) — Whisper hangs a pause on either neighbouring word, so only the audio knows.
 *   2. The start and the end move to the nearest clean boundary within 6 s — adding words
 *      is preferred over dropping them — while keeping the clip inside the length limits.
 *      No clean one → the nearest soft one → left where it was.
 *   3. The cut goes at most 0.4 s before the first word and 0.7 s after the last one (or
 *      where the audio shows speech really starts/stops), in the quietest 20 ms there, so
 *      no syllable is clipped and there is little dead air.
 * Without word timestamps whole segments are the units; without audio the cuts use fixed
 * lead/tail times.
 */

export const SNAP_VERSION = "snap@1";

export const SNAP_RULES = {
  /** A quiet stretch (or timestamp gap) this long between two words is a pause… */
  pauseMs: 250,
  /** …and this long is a clean boundary on its own. */
  strongPauseMs: 600,
  /** A quiet stretch this far from a word boundary still belongs to it. */
  pauseReachMs: 400,
  /** How far a boundary may move to reach a clean one. */
  searchMs: 6_000,
  /** Dropping words costs this much more per second than adding words. */
  shrinkCost: 1.5,
  maxLeadMs: 400,
  idealLeadMs: 150,
  maxTailMs: 700,
  idealTailMs: 300,
  /** Neighbouring words closer than this touch (Whisper stretched one over the pause). */
  touchingMs: 60,
  /** Extra loudness (dB) accepted per second closer to the ideal cut point. */
  dbPerSecond: 6,
};

/** clean = a boundary a person would cut at; soft = maybe; mid = mid-phrase. */
type Strength = 0 | 1 | 2;
const CLEAN: Strength = 2;

type Span = { startMs: number; endMs: number };

export type SnapUnit = Span & {
  text: string;
  /** Strength of the boundary after this unit. */
  after: Strength;
  /** The audio's quiet stretch at that boundary, if any. */
  pauseAfter: Span | null;
};

export type SnapTrack = {
  units: SnapUnit[];
  loudness: Loudness | null;
  durationMs: number;
  basis: "words+audio" | "words" | "segments+audio" | "segments";
};

export const SNAP_START_RULES = ["clean", "earlier", "later", "soft", "none"] as const;
export const SNAP_END_RULES = ["clean", "later", "earlier", "soft", "none", "max_cut"] as const;
export type SnapStartRule = (typeof SNAP_START_RULES)[number];
export type SnapEndRule = (typeof SNAP_END_RULES)[number];

export type SnapResult = {
  startMs: number;
  endMs: number;
  startRule: SnapStartRule;
  endRule: SnapEndRule;
  startClean: boolean;
  endClean: boolean;
  text: string;
};

export function buildSnapTrack(args: {
  segments: readonly Segment[];
  words: readonly Word[] | null;
  loudness: Loudness | null;
  durationMs: number;
  rules?: typeof SNAP_RULES;
}): SnapTrack {
  const { segments, words, loudness, durationMs, rules = SNAP_RULES } = args;
  const bySegment = wordsBySegment(segments, words);
  const raw: { startMs: number; endMs: number; text: string; segmentEnd: boolean }[] = [];
  let anyWords = false;
  for (const [i, seg] of segments.entries()) {
    const own = bySegment[i]!.map(([startMs, endMs, text]) => ({ startMs, endMs, text: text.trim() })).filter((w) => w.text);
    if (own.length > 0) anyWords = true;
    const units = own.length > 0 ? own : seg.text.trim() ? [{ startMs: seg.startMs, endMs: seg.endMs, text: seg.text.trim() }] : [];
    units.forEach((u, k) => raw.push({ ...u, segmentEnd: k === units.length - 1 }));
  }

  const pauses = loudness ? pausesAtJoints(raw, quietRuns(loudness, rules.pauseMs), rules.pauseReachMs) : [];
  const units: SnapUnit[] = raw.map((u, i) => {
    const next = raw[i + 1];
    const base = { startMs: u.startMs, endMs: u.endMs, text: u.text };
    if (!next) return { ...base, after: CLEAN, pauseAfter: null };
    const quiet = pauses[i] ?? null;
    const pause = Math.max(next.startMs - u.endMs, quiet ? quiet.endMs - quiet.startMs : 0);
    const points =
      (SENTENCE_END.test(u.text) ? 2 : 0) + (u.segmentEnd ? 1 : 0) + (pause >= rules.strongPauseMs ? 2 : pause >= rules.pauseMs ? 1 : 0);
    return { ...base, after: Math.min(points, 2) as Strength, pauseAfter: quiet };
  });

  const unitKind = anyWords ? "words" : "segments";
  return { units, loudness, durationMs, basis: loudness ? `${unitKind}+audio` : unitKind };
}

/**
 * Snap one clip (times from the line-level fit). Null when no word falls inside it, or no
 * cut fits the length limits — the caller then keeps the line times.
 */
export function snapClip(
  track: SnapTrack,
  clip: { startMs: number; endMs: number },
  limits: { minMs: number; maxMs: number },
  rules = SNAP_RULES,
): SnapResult | null {
  const u = track.units;
  const s = u.findIndex((x) => mid(x) >= clip.startMs);
  const e = findLastIndex(u, (x) => mid(x) <= clip.endMs);
  if (s < 0 || e < s) return null;

  // Lead + tail are added after this, so the words alone must leave room for them.
  const maxSpeech = Math.max(limits.maxMs - rules.maxLeadMs - rules.maxTailMs, limits.minMs);
  const span = (a: number, b: number) => u[b]!.endMs - u[a]!.startMs;
  const startStrength = (a: number): Strength => (a === 0 ? CLEAN : u[a - 1]!.after);

  // Start first: moving it earlier may not push the words past the maximum; later is
  // always allowed (the end step fixes the length) as long as the minimum still holds.
  const start = pick({
    current: s,
    count: u.length,
    timeOf: (a) => u[a]!.startMs,
    strengthOf: startStrength,
    valid: (a) => a <= e && span(a, e) >= limits.minMs && (a >= s || span(a, e) <= maxSpeech),
    grows: (a) => a < s,
    rules,
  });
  if (!start) return null;
  const a = start.index;

  const endValid = (b: number) => b >= a && span(a, b) >= limits.minMs && span(a, b) <= maxSpeech;
  let ref = e;
  let forced = false;
  if (!endValid(e) && span(a, e) > maxSpeech) {
    // Too long: look around the last word that still fits.
    forced = true;
    ref = findLastIndex(u, (x, i) => i >= a && x.endMs - u[a]!.startMs <= maxSpeech);
    if (ref < a) return null;
  }
  const end = pick({
    current: ref,
    count: u.length,
    timeOf: (b) => u[b]!.endMs,
    strengthOf: (b) => u[b]!.after,
    valid: endValid,
    grows: (b) => b > ref,
    rules,
  });
  if (!end) return null;
  const b = end.index;

  const startClean = startStrength(a) === CLEAN;
  const endClean = u[b]!.after === CLEAN;
  let startMs = Math.max(0, startCut(track, a, rules));
  let endMs = endCut(track, b, rules);
  if (track.durationMs > 0) endMs = Math.min(endMs, track.durationMs);
  if (endMs - startMs > limits.maxMs) endMs = startMs + limits.maxMs;
  startMs = Math.round(startMs);
  endMs = Math.round(endMs);

  return {
    startMs,
    endMs,
    startRule: start.rule,
    endRule: forced && !endClean ? "max_cut" : end.rule,
    startClean,
    endClean,
    text: u
      .slice(a, b + 1)
      .map((x) => x.text)
      .join(" "),
  };
}

type Pick = { index: number; rule: SnapStartRule & SnapEndRule };

/**
 * The boundary to cut at, around `current`: kept if clean; else the cheapest clean one
 * within `searchMs`; else the cheapest soft one (or current if soft); else current, or
 * (current not allowed) the nearest allowed one.
 */
function pick(args: {
  current: number;
  count: number;
  timeOf: (i: number) => number;
  strengthOf: (i: number) => Strength;
  valid: (i: number) => boolean;
  grows: (i: number) => boolean;
  rules: typeof SNAP_RULES;
}): Pick | null {
  const { current, count, timeOf, strengthOf, valid, grows, rules } = args;
  if (valid(current) && strengthOf(current) === CLEAN) return { index: current, rule: "clean" };

  const t0 = timeOf(current);
  const nearby: { i: number; cost: number }[] = [];
  for (const dir of [-1, 1]) {
    for (let i = current + dir; i >= 0 && i < count && Math.abs(timeOf(i) - t0) <= rules.searchMs; i += dir) {
      if (valid(i)) nearby.push({ i, cost: Math.abs(timeOf(i) - t0) * (grows(i) ? 1 : rules.shrinkCost) });
    }
  }
  const cheapest = (minStrength: Strength) =>
    nearby.filter((c) => strengthOf(c.i) >= minStrength).reduce<{ i: number; cost: number } | null>((best, c) => (!best || c.cost < best.cost ? c : best), null);
  const moved = (i: number): Pick["rule"] => (timeOf(i) < t0 ? "earlier" : "later");

  const clean = cheapest(CLEAN);
  if (clean) return { index: clean.i, rule: moved(clean.i) };
  if (valid(current) && strengthOf(current) === 1) return { index: current, rule: "soft" };
  const soft = cheapest(1);
  if (soft) return { index: soft.i, rule: "soft" };
  if (valid(current)) return { index: current, rule: "none" };
  const any = cheapest(0);
  return any ? { index: any.i, rule: "none" } : null;
}

/**
 * At most maxLeadMs before speech resumes — dead air at the start of a short loses viewers,
 * and in noisy audio (a crowd) the quiet can end long before the words do. Speech resumes
 * at the first word, or later if the audio stays quiet into it.
 */
function startCut(track: SnapTrack, a: number, rules: typeof SNAP_RULES): number {
  const first = track.units[a]!;
  const prev = track.units[a - 1];
  const quiet = prev?.pauseAfter;
  const resume = quiet && quiet.endMs > first.startMs ? Math.min(quiet.endMs, mid(first)) : first.startMs;
  let lo = Math.max(prev ? prev.endMs : 0, resume - rules.maxLeadMs);
  // Touching words: Whisper stretched the previous word over the pause — look inside its tail.
  if (prev && resume - lo < rules.touchingMs) lo = Math.max(mid(prev), resume - rules.maxLeadMs);
  return quietest(track.loudness, lo, resume, resume - rules.idealLeadMs, rules);
}

/**
 * At most maxTailMs after speech stops: at the last word's end, or earlier if the audio
 * goes quiet inside it (Whisper stretched it over the pause).
 */
function endCut(track: SnapTrack, b: number, rules: typeof SNAP_RULES): number {
  const last = track.units[b]!;
  const next = track.units[b + 1];
  const quiet = next ? last.pauseAfter : null;
  const stop = quiet && quiet.startMs < last.endMs ? Math.max(quiet.startMs, mid(last)) : last.endMs;
  const hi = Math.max(stop, Math.min(next ? next.startMs : track.durationMs || Infinity, stop + rules.maxTailMs));
  if (next && hi - stop < rules.touchingMs) {
    // Touching words and no quiet found: look inside this word's (maybe stretched) end.
    return quietest(track.loudness, Math.max(mid(last), stop - rules.maxTailMs / 2), hi, hi, rules);
  }
  return quietest(track.loudness, stop, hi, stop + rules.idealTailMs, rules);
}

/** The quietest frame in [lo, hi], with a small pull toward `ideal`. No audio → `ideal`. */
function quietest(loudness: Loudness | null, lo: number, hi: number, ideal: number, rules: typeof SNAP_RULES): number {
  const target = Math.min(Math.max(ideal, lo), hi);
  if (!loudness || hi - lo < loudness.frameMs) return target;
  const f = loudness.frameMs;
  let best = target;
  let bestCost = Infinity;
  for (let i = Math.ceil(lo / f); i * f + f / 2 <= hi && i < loudness.db.length; i++) {
    const t = i * f + f / 2;
    const cost = loudness.db[i]! + (rules.dbPerSecond * Math.abs(t - target)) / 1000;
    if (cost < bestCost) {
      bestCost = cost;
      best = t;
    }
  }
  return best;
}

/**
 * Gives each quiet stretch to the word boundary nearest to it (inside it, or within
 * `reachMs`); a boundary keeps its longest. Index i = the boundary after unit i.
 */
function pausesAtJoints(units: readonly Span[], runs: readonly Span[], reachMs: number): (Span | null)[] {
  const joints = units.slice(0, -1).map((u, i) => (u.endMs + units[i + 1]!.startMs) / 2);
  const out: (Span | null)[] = joints.map(() => null);
  let k = 0;
  for (const run of runs) {
    while (k < joints.length && joints[k]! < run.startMs - reachMs) k++;
    let best = -1;
    let bestDist = Infinity;
    for (let j = k; j < joints.length && joints[j]! <= run.endMs + reachMs; j++) {
      const t = joints[j]!;
      const outside = t < run.startMs ? run.startMs - t : t > run.endMs ? t - run.endMs : 0;
      // Inside beats outside; among those inside, nearest the middle of the stretch.
      const dist = outside > 0 ? reachMs + outside : Math.abs(t - (run.startMs + run.endMs) / 2) / 1e6;
      if (dist < bestDist) {
        bestDist = dist;
        best = j;
      }
    }
    const prev = best >= 0 ? out[best] : undefined;
    if (best >= 0 && (!prev || prev.endMs - prev.startMs < run.endMs - run.startMs)) out[best] = run;
  }
  return out;
}

function mid(x: { startMs: number; endMs: number }): number {
  return (x.startMs + x.endMs) / 2;
}

function findLastIndex<T>(list: readonly T[], fn: (x: T, i: number) => boolean): number {
  for (let i = list.length - 1; i >= 0; i--) if (fn(list[i]!, i)) return i;
  return -1;
}
