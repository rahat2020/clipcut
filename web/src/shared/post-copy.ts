// GENERATED — do not edit. Source: shared/src/post-copy.ts
// Edit the source, then run: node scripts/sync-shared.mjs

/**
 * Post text for a clip (Step 15): the limits and the hashtag rules, shared by the worker
 * (cleaning the AI's answer), web (the user's edits) and the clip card. Plain values only,
 * so client code may import this file.
 */

export const POST_COPY = {
  titleMaxChars: 100,
  hookMaxChars: 150,
  descriptionMaxChars: 500,
  hashtagMaxChars: 40,
  coverTextMaxChars: 40,
  maxCoverOptions: 3,
  maxHashtags: 8,
} as const;

/**
 * "#Bangladesh football!" → "#Bangladeshfootball". Keeps letters (any script, with their
 * vowel signs), digits and "_"; null when nothing is left.
 */
export function normalizeHashtag(raw: string): string | null {
  const body = raw
    .normalize("NFC")
    .replace(/^#+/, "")
    .replace(/[^\p{L}\p{M}\p{N}_]/gu, "")
    .slice(0, POST_COPY.hashtagMaxChars);
  return body ? `#${body}` : null;
}

/** Cleaned, without duplicates (case-insensitive), at most `maxHashtags`. */
export function normalizeHashtags(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const tag = normalizeHashtag(raw);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
    if (out.length >= POST_COPY.maxHashtags) break;
  }
  return out;
}

/** One line, trimmed, at most `max` characters (cut at a word when possible). */
export function oneLineText(text: string, max: number): string {
  const flat = text.normalize("NFC").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trim();
}

/** A cover word without punctuation, for matching ("গোল!" → "গোল"). */
function bareWord(word: string): string {
  return word.normalize("NFC").replace(/[^\p{L}\p{M}\p{N}]/gu, "").toLowerCase();
}

/** The cover words, split the way the editor and the drawing split them. */
export function coverWords(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/** Which words of a cover text are in the second colour (indices into `coverWords(text)`). */
export function coverHighlightIndices(text: string, highlight: string): number[] {
  const wanted = new Set(coverWords(highlight).map(bareWord).filter(Boolean));
  if (wanted.size === 0) return [];
  return coverWords(text).flatMap((w, i) => (wanted.has(bareWord(w)) ? [i] : []));
}

/** The AI's highlight, kept only when it is some (not all) of the text's words; else "". */
export function cleanCoverHighlight(text: string, highlight: string): string {
  const words = new Set(coverWords(text).map(bareWord).filter(Boolean));
  const wanted = coverWords(highlight).filter((w) => bareWord(w));
  if (wanted.length === 0 || wanted.length >= words.size || !wanted.every((w) => words.has(bareWord(w)))) return "";
  return wanted.join(" ");
}
