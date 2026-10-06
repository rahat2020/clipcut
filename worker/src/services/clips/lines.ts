/**
 * The transcript as the clip-picking AI sees it: short numbered lines with times.
 *
 * The AI answers with line numbers, never times (ARCHITECTURE: AI decides WHAT, code
 * decides HOW), so a line is the finest cut the AI can ask for. Whisper segments are too
 * coarse for that — one real segment ran 21 s → 51 s while its words ended at 28.8 s — so
 * segments are split at sentence ends and pauses using the word timestamps, and each line
 * ends where its last word ends.
 */

export type Line = { n: number; startMs: number; endMs: number; text: string };

export type Segment = { startMs: number; endMs: number; text: string };
/** Word timestamps as stored in Cloudinary: [startMs, endMs, word]. */
export type Word = [number, number, string];

export const LINE_RULES = {
  /** Close a line at a sentence end once it's at least this long. */
  sentenceMinMs: 1_500,
  /** Close a line at a pause this long… */
  pauseMs: 700,
  /** …once the line is at least this long. */
  pauseMinMs: 1_500,
  /** Past this length, close at a comma or any small gap. */
  softMaxMs: 8_000,
  softGapMs: 250,
  /** Never longer than this. */
  hardMaxMs: 15_000,
};

export const SENTENCE_END = /[।॥?!.…]["'”’)]*$/u;
const SOFT_END = /[,;:—–-]["'”’)]*$/u;

export function buildLines(segments: readonly Segment[], words: readonly Word[] | null, rules = LINE_RULES): Line[] {
  const out: Omit<Line, "n">[] = [];
  const bySegment = wordsBySegment(segments, words);
  for (const [i, seg] of segments.entries()) {
    const own = bySegment[i]!;
    if (own.length === 0) {
      const text = seg.text.trim();
      if (text) out.push({ startMs: seg.startMs, endMs: seg.endMs, text });
      continue;
    }
    out.push(...splitWords(own, rules));
  }
  return out.map((l, i) => ({ ...l, n: i + 1 }));
}

function splitWords(words: Word[], rules: typeof LINE_RULES): Omit<Line, "n">[] {
  const lines: Omit<Line, "n">[] = [];
  let current: Word[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    current.push(word);
    const next = words[i + 1];
    const dur = word[1] - current[0]![0];
    const gap = next ? next[0] - word[1] : Infinity;
    const text = word[2].trim();
    const close =
      !next ||
      (SENTENCE_END.test(text) && dur >= rules.sentenceMinMs) ||
      (gap >= rules.pauseMs && dur >= rules.pauseMinMs) ||
      ((SOFT_END.test(text) || gap >= rules.softGapMs) && dur >= rules.softMaxMs) ||
      dur >= rules.hardMaxMs;
    if (close) {
      const text = current.map((x) => x[2].trim()).filter(Boolean).join(" ");
      if (text) lines.push({ startMs: current[0]![0], endMs: word[1], text });
      current = [];
    }
  }
  return lines;
}

/**
 * Each segment's own words: a word belongs to the segment its midpoint falls in (both lists
 * are in time order). Words outside every segment are left out.
 */
export function wordsBySegment(segments: readonly Segment[], words: readonly Word[] | null): Word[][] {
  let w = 0;
  return segments.map((seg) => {
    const own: Word[] = [];
    while (words && w < words.length && mid(words[w]!) < seg.startMs) w++;
    while (words && w < words.length && mid(words[w]!) <= seg.endMs) own.push(words[w++]!);
    return own;
  });
}

function mid(word: Word): number {
  return (word[0] + word[1]) / 2;
}

/** 83_400 → "01:23", 3_723_000 → "1:02:03". Whole seconds, rounded down. */
export function formatClock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** "L12 [03:21-03:27] text" — one per line, the block the prompt embeds. */
export function formatLines(lines: readonly Line[]): string {
  return lines.map((l) => `L${l.n} [${formatClock(l.startMs)}-${formatClock(l.endMs)}] ${l.text}`).join("\n");
}

/**
 * The lines a stretch of time covers (a line counts when most of it is inside), merged
 * into ranges for the prompt. Stretches that cover no line are left out.
 */
export function lineRangesFor(lines: readonly Line[], stretches: readonly { startMs: number; endMs: number }[]): { startLine: number; endLine: number }[] {
  const inside = (l: Line, s: { startMs: number; endMs: number }) =>
    Math.min(l.endMs, s.endMs) - Math.max(l.startMs, s.startMs) > (l.endMs - l.startMs) / 2;
  const ranges: { startLine: number; endLine: number }[] = [];
  for (const s of [...stretches].sort((a, b) => a.startMs - b.startMs)) {
    const covered = lines.filter((l) => inside(l, s));
    if (covered.length === 0) continue;
    const startLine = covered[0]!.n;
    const endLine = covered.at(-1)!.n;
    const last = ranges.at(-1);
    if (last && startLine <= last.endLine + 1) last.endLine = Math.max(last.endLine, endLine);
    else ranges.push({ startLine, endLine });
  }
  return ranges;
}
