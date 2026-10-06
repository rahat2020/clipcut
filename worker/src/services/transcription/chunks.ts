import { quietRuns, type Loudness, type Span } from "../media/loudness";

/**
 * Cutting the audio into short pieces for chunked transcription (Gemini writes the text of
 * each piece; the piece's own start/end are the timing). Pure, so it's easy to test.
 *
 * Pieces end in the middle of a pause when there is one (the longest quiet stretch, nearest
 * the target length), else at the quietest 200 ms — music under speech has no real quiet.
 */

export const CHUNK_RULES = {
  minMs: 3_000,
  targetMs: 10_000,
  maxMs: 15_000,
  /** Quiet stretches shorter than this aren't pauses to cut in. */
  minPauseMs: 150,
  /** A pause further from the target loses this many ms of "length" per second. */
  distancePenaltyMsPerS: 40,
  /** No pause: cut at the quietest window of this size… */
  windowMs: 200,
  /** …no earlier than this share of the target length. */
  fallbackFromShare: 0.6,
};

export function chunkAudio(loudness: Loudness, durationMs: number, rules = CHUNK_RULES): Span[] {
  const runs = quietRuns(loudness, rules.minPauseMs);
  const chunks: Span[] = [];
  let start = 0;
  while (durationMs - start > rules.maxMs) {
    const lo = start + rules.minMs;
    // Never leave a last piece shorter than the minimum.
    const hi = Math.min(start + rules.maxMs, durationMs - rules.minMs);
    const target = start + rules.targetMs;
    let cut = -1;
    let best = -Infinity;
    for (const r of runs) {
      if (r.endMs <= lo) continue;
      if (r.startMs >= hi) break;
      const mid = Math.min(Math.max((r.startMs + r.endMs) / 2, lo), hi);
      const len = Math.min(r.endMs, hi) - Math.max(r.startMs, lo);
      const score = len - (Math.abs(mid - target) / 1000) * rules.distancePenaltyMsPerS;
      if (score > best) {
        best = score;
        cut = mid;
      }
    }
    if (cut < 0) cut = quietestWindow(loudness, start + rules.targetMs * rules.fallbackFromShare, hi, rules.windowMs);
    cut = Math.round(cut);
    chunks.push({ startMs: start, endMs: cut });
    start = cut;
  }
  if (durationMs > start) chunks.push({ startMs: start, endMs: Math.round(durationMs) });
  return chunks;
}

/** Centre of the quietest `windowMs` inside [lo, hi] (mean dB, frame by frame). */
function quietestWindow(loudness: Loudness, lo: number, hi: number, windowMs: number): number {
  const f = loudness.frameMs;
  const n = Math.max(1, Math.round(windowMs / f));
  const first = Math.max(0, Math.floor(lo / f));
  const last = Math.min(loudness.db.length - n, Math.floor(hi / f) - n);
  if (last < first) return hi;
  let sum = 0;
  for (let i = first; i < first + n; i++) sum += loudness.db[i]!;
  let bestSum = sum;
  let bestAt = first;
  for (let i = first + 1; i <= last; i++) {
    sum += loudness.db[i + n - 1]! - loudness.db[i - 1]!;
    if (sum < bestSum) {
      bestSum = sum;
      bestAt = i;
    }
  }
  return (bestAt + n / 2) * f;
}

/**
 * Word times for a piece whose text has no timing of its own: the words are spread over
 * the piece's speech (non-quiet frames) in proportion to their length in characters —
 * good enough for phrase captions and for snapping, which also listens to the audio.
 * Returns [startMs, endMs, word] like Whisper's words.
 */
export function estimateWordTimes(text: string, chunk: Span, loudness: Loudness | null): [number, number, string][] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const weights = words.map((w) => Math.max(graphemes(w), 1));
  const total = weights.reduce((a, b) => a + b, 0);

  // The piece's speech timeline: frames that aren't quiet (all of them without a threshold).
  const f = loudness?.frameMs ?? 20;
  const speech: number[] = [];
  if (loudness?.quietDb != null) {
    for (let t = chunk.startMs; t < chunk.endMs; t += f) {
      const db = loudness.db[Math.floor(t / f)];
      if (db === undefined || db > loudness.quietDb) speech.push(t);
    }
  }
  // Too little speech found (all quiet, or no audio): spread evenly over the whole piece.
  const timeline = speech.length * f >= (chunk.endMs - chunk.startMs) * 0.2 ? speech : null;
  const at = (share: number): number => {
    if (!timeline) return chunk.startMs + share * (chunk.endMs - chunk.startMs);
    const i = Math.min(Math.floor(share * timeline.length), timeline.length - 1);
    return timeline[i]!;
  };

  const out: [number, number, string][] = [];
  let done = 0;
  for (const [i, word] of words.entries()) {
    const start = at(done / total);
    done += weights[i]!;
    const end = i === words.length - 1 && timeline ? timeline.at(-1)! + f : at(done / total);
    out.push([Math.round(start), Math.round(Math.max(end, start + 1)), word]);
  }
  return out;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function graphemes(word: string): number {
  let n = 0;
  for (const _ of segmenter.segment(word)) n++;
  return n;
}
