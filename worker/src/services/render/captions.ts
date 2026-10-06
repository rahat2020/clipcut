import type { Word } from "../clips/lines";
import type { CaptionStyle } from "../../shared";

/**
 * Burned-in captions as an ASS subtitle file (rendered by ffmpeg's `ass` filter with
 * `shaping=complex`, so যুক্তাক্ষর join correctly — CLAUDE.md "Always").
 *
 * Words are grouped into short phrases (a few words, one line) the way short-form captions
 * look: a phrase closes at a sentence end, a pause, or when it gets too long. Times are
 * relative to the clip start, because the encoder seeks the input to the clip start.
 *
 * Bangla word times are estimates (D42) — phrases, not single words, keep that invisible.
 */

export const CAPTION_RULES = {
  /** Close a phrase at a pause this long. */
  gapMs: 450,
  /** Never show one phrase longer than this. */
  maxMs: 2_800,
  /** Keep a phrase on screen this long after its last word (unless the next one starts). */
  holdMs: 300,
  /** Shorter phrases are stretched to this (into the following silence only). */
  minMs: 700,
};

export type Phrase = { startMs: number; endMs: number; text: string };

const SENTENCE_END = /[।॥?!.…]["'”’)]*$/u;
/** Punctuation dropped at the end of a caption word — captions read cleaner without it. */
const TRAILING = /[,;:।॥.]+$/u;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function length(text: string): number {
  let n = 0;
  for (const _ of graphemes.segment(text)) n++;
  return n;
}

/** The clip's words, with times relative to the clip start. A word belongs to the clip if its middle falls inside. */
export function clipWords(words: readonly Word[], startMs: number, endMs: number): Word[] {
  const out: Word[] = [];
  for (const [s, e, text] of words) {
    const mid = (s + e) / 2;
    if (mid < startMs || mid > endMs) continue;
    const t = text.trim();
    if (!t) continue;
    out.push([Math.max(s - startMs, 0), Math.min(e, endMs) - startMs, t]);
  }
  return out;
}

/**
 * Words when the word-timestamp file couldn't be read: each segment's text spread over
 * its time by length. Coarse, but captions still line up phrase by phrase.
 */
export function wordsFromSegments(segments: readonly { startMs: number; endMs: number; text: string }[]): Word[] {
  const out: Word[] = [];
  for (const seg of segments) {
    const parts = seg.text.split(/\s+/).filter(Boolean);
    const total = parts.reduce((sum, p) => sum + length(p), 0);
    if (total === 0) continue;
    let at = seg.startMs;
    const span = Math.max(seg.endMs - seg.startMs, 0);
    for (const p of parts) {
      const dur = (span * length(p)) / total;
      out.push([Math.round(at), Math.round(at + dur), p]);
      at += dur;
    }
  }
  return out;
}

export function buildPhrases(words: readonly Word[], style: Pick<CaptionStyle, "maxChars" | "maxWords">, clipMs: number, rules = CAPTION_RULES): Phrase[] {
  const groups: Word[][] = [];
  let current: Word[] = [];
  let chars = 0;
  for (const [i, w] of words.entries()) {
    const text = w[2];
    const add = length(text) + (current.length > 0 ? 1 : 0);
    if (current.length > 0 && (chars + add > style.maxChars || current.length >= style.maxWords || w[1] - current[0]![0] > rules.maxMs)) {
      groups.push(current);
      current = [];
      chars = 0;
    }
    current.push(w);
    chars += length(text) + (current.length > 1 ? 1 : 0);
    const next = words[i + 1];
    if (!next || SENTENCE_END.test(text) || next[0] - w[1] >= rules.gapMs) {
      groups.push(current);
      current = [];
      chars = 0;
    }
  }
  if (current.length > 0) groups.push(current);

  const phrases: Phrase[] = [];
  for (const [i, g] of groups.entries()) {
    const text = g
      .map((w) => w[2].replace(TRAILING, ""))
      .filter(Boolean)
      .join(" ");
    if (!text) continue;
    const start = g[0]![0];
    const nextStart = groups[i + 1]?.[0]?.[0] ?? clipMs;
    const end = Math.min(Math.max(g.at(-1)![1] + rules.holdMs, start + rules.minMs), nextStart, clipMs);
    if (end > start) phrases.push({ startMs: start, endMs: end, text });
  }
  return phrases;
}

/** h:mm:ss.cc — ASS times are centiseconds. */
function assTime(ms: number): string {
  const cs = Math.max(Math.round(ms / 10), 0);
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6_000);
  const s = Math.floor((cs % 6_000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

/** User speech must never become ASS markup: `{…}` is an override block, `\` starts a tag. */
function escapeText(text: string): string {
  return text.replace(/[{}]/g, (c) => (c === "{" ? "(" : ")")).replace(/\\/g, "/").replace(/\s+/g, " ");
}

export function buildAss(phrases: readonly Phrase[], style: CaptionStyle, size: { width: number; height: number }): string {
  const h = size.height;
  const px = (share: number) => Math.round(share * h);
  const fontSize = px(style.size);
  const marginH = Math.round(size.width * 0.07);
  const styleLine = [
    "Caption",
    style.fontFamily,
    fontSize,
    style.primaryColour,
    style.primaryColour,
    style.outlineColour,
    style.backColour,
    style.bold ? -1 : 0,
    0,
    0,
    0,
    100,
    100,
    0,
    0,
    style.borderStyle,
    Math.max(px(style.outline), 1),
    px(style.shadow),
    2, // bottom centre
    marginH,
    marginH,
    px(style.marginV),
    1,
  ].join(",");
  const pop = style.pop ? "{\\fscx88\\fscy88\\t(0,90,\\fscx100\\fscy100)}" : "";
  const events = phrases.map((p) => `Dialogue: 0,${assTime(p.startMs)},${assTime(p.endMs)},Caption,,0,0,0,,${pop}${escapeText(p.text)}`);

  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${size.width}`,
    `PlayResY: ${size.height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: ${styleLine}`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
}
