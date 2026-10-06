/**
 * Unicode normalisation for every piece of stored text.
 *
 * NFC makes visually identical Bangla strings byte-identical (Whisper, browsers and
 * keyboards don't always agree on composed vs decomposed forms), which matters for
 * search, dedup and caption timing. NFC keeps ZERO WIDTH JOINER / NON-JOINER
 * (U+200D / U+200C) — Bangla forms like র‍্যা depend on them, so never "clean" them out.
 */
export function normalizeText(value: string): string;
export function normalizeText(value: string | null | undefined): string | null | undefined;
export function normalizeText(value: string | null | undefined): string | null | undefined {
  return typeof value === "string" ? value.normalize("NFC") : value;
}
