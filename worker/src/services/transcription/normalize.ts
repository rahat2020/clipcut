import { normalizeText } from "../../shared";
import type { RawTranscription } from "./groq";

/**
 * Whisper output → what we store. Pure (no I/O) so it's unit-tested.
 *
 * - Times become integer milliseconds, clamped to the audio length (docs/SCHEMA.md §2).
 * - Text is NFC-normalised (keeps ZWJ/ZWNJ for Bangla conjuncts), trimmed.
 * - Three kinds of Whisper hallucination are dropped:
 *   1. Text over silence/noise: OpenAI's own rule — no_speech_prob > 0.6 AND
 *      avg_logprob < -1. Either alone is unreliable (Groq reports both per 30 s window;
 *      real Bangla speech showed no_speech_prob 0.64 with a confident logprob).
 *   2. Repetition loops: the same text 3+ times in a row keeps only the first.
 *   3. Stock filler phrases over probable silence ("you", "Thank you.", "Thanks for
 *      watching!") with no_speech_prob > 0.5 — seen 2026-09-29: "you" at 5:44 of a football
 *      video, no_speech 0.73 but logprob -0.71, so rule 1 kept it.
 * - Words are kept only inside kept segments, in time order.
 */

export type StoredSegment = { startMs: number; endMs: number; text: string; avgLogprob?: number; noSpeechProb?: number };
/** Compact word record for the Cloudinary JSON: start ms, end ms, text. */
export type StoredWord = [startMs: number, endMs: number, word: string];

export type NormalizedTranscript = {
  segments: StoredSegment[];
  words: StoredWord[];
  stats: { wordCount: number; segmentCount: number; avgLogprob?: number; droppedSegments: number };
};

const NO_SPEECH = 0.6;
const LOW_LOGPROB = -1;
const LOOP_REPEATS = 3;
const FILLER_NO_SPEECH = 0.5;
/** loopKey() forms of phrases Whisper writes over silence (English and Bangla). */
const FILLER_PHRASES = new Set(["you", "thankyou", "thanks", "thanksforwatching", "thankyouforwatching", "bye", "byebye", "ধন্যবাদ"]);

const toMs = (sec: number, maxMs: number) => Math.min(Math.max(Math.round(sec * 1000), 0), maxMs);
const clean = (s: string) => normalizeText(s).replace(/\s+/g, " ").trim();
const loopKey = (s: string) => s.toLowerCase().replace(/[\s\p{P}]+/gu, "");

export function normalizeTranscription(raw: RawTranscription, durationMs: number): NormalizedTranscript {
  const maxMs = Math.max(durationMs, 0) || Number.MAX_SAFE_INTEGER;
  let dropped = 0;

  const kept: StoredSegment[] = [];
  let runKey = "";
  let runLength = 0;
  for (const s of [...raw.segments].sort((a, b) => a.start - b.start)) {
    const text = clean(s.text);
    const silent = (s.no_speech_prob ?? 0) > NO_SPEECH && (s.avg_logprob ?? 0) < LOW_LOGPROB;
    const key = loopKey(text);
    const filler = FILLER_PHRASES.has(key) && (s.no_speech_prob ?? 0) > FILLER_NO_SPEECH;
    runLength = key && key === runKey ? runLength + 1 : 1;
    runKey = key;
    if (!text || !key || silent || filler || runLength >= LOOP_REPEATS) {
      dropped++;
      continue;
    }
    const startMs = toMs(s.start, maxMs);
    const endMs = Math.max(toMs(s.end, maxMs), startMs);
    kept.push({
      startMs,
      endMs,
      text,
      ...(s.avg_logprob != null ? { avgLogprob: s.avg_logprob } : {}),
      ...(s.no_speech_prob != null ? { noSpeechProb: Math.min(Math.max(s.no_speech_prob, 0), 1) } : {}),
    });
  }

  // A word belongs to a kept segment if its midpoint falls inside one.
  const inKept = (midMs: number) => kept.some((k) => midMs >= k.startMs && midMs <= k.endMs);
  const words: StoredWord[] = [];
  for (const w of [...raw.words].sort((a, b) => a.start - b.start)) {
    const text = clean(w.word);
    if (!text) continue;
    const startMs = toMs(w.start, maxMs);
    const endMs = Math.max(toMs(w.end, maxMs), startMs);
    if (kept.length && !inKept((startMs + endMs) / 2)) continue;
    words.push([startMs, endMs, text]);
  }

  // Duration-weighted mean confidence of what we kept.
  let weight = 0;
  let sum = 0;
  for (const k of kept) {
    if (k.avgLogprob == null) continue;
    const w = Math.max(k.endMs - k.startMs, 1);
    weight += w;
    sum += k.avgLogprob * w;
  }

  return {
    segments: kept,
    words: kept.length ? words : [],
    stats: {
      wordCount: kept.length ? words.length : 0,
      segmentCount: kept.length,
      ...(weight ? { avgLogprob: Math.round((sum / weight) * 1000) / 1000 } : {}),
      droppedSegments: dropped,
    },
  };
}
