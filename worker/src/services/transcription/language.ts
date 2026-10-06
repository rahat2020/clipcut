import path from "node:path";

import { env } from "../../config/env";
import { runTool } from "../../lib/exec";
import { LANGUAGES, type Language } from "../../shared";
import { transcribeWithGroq, type RawTranscription } from "./groq";

/**
 * Checks the spoken language the user picked before the full transcription.
 *
 * Why: forcing Whisper to the wrong language doesn't fail — it writes the English
 * commentary of a football video as nonsense in Bengali script (seen 2026-09-29), and
 * every later step (clip picking, captions) inherits it. The form defaults to Bangla, so
 * wrong picks will be common.
 *
 * How: 1–2 samples of 30 s from the MIDDLE of the audio (intros are often music or an
 * English channel jingle), transcribed without a language. Whisper names the language.
 */

export const SAMPLE_SEC = 30;

export type LanguageSample = { detected: string | null; words: number; usable: boolean };

/** Whisper's language names → our codes. Anything else isn't a language we support. */
const NAMES: Record<string, Language> = { bengali: "bn", bangla: "bn", bn: "bn", english: "en", en: "en" };

export function toSupportedLanguage(name: string | null | undefined): Language | null {
  const code = NAMES[(name ?? "").trim().toLowerCase()];
  return code && (LANGUAGES as readonly string[]).includes(code) ? code : null;
}

/** Sample start times (seconds): one for short videos, two (~30 % and ~65 %) for longer ones. */
export function sampleStarts(durationMs: number): number[] {
  const d = durationMs / 1000;
  if (d <= SAMPLE_SEC * 1.5) return [0];
  if (d < 150) return [Math.max(0, d / 2 - SAMPLE_SEC / 2)];
  return [Math.floor(d * 0.3), Math.floor(d * 0.65)].map((s) => Math.min(s, Math.max(0, d - SAMPLE_SEC)));
}

/**
 * A sample only counts if it clearly contained speech: Whisper still "detects" a language
 * on music or crowd noise, usually English, with little or no text.
 */
export function readSample(raw: RawTranscription): LanguageSample {
  const words = raw.text.trim().split(/\s+/).filter(Boolean).length;
  const noSpeech =
    raw.segments.length === 0 ? 1 : raw.segments.reduce((sum, s) => sum + (s.no_speech_prob ?? 0), 0) / raw.segments.length;
  return { detected: raw.language ?? null, words, usable: words >= 5 && noSpeech < 0.8 };
}

export type LanguageDecision = { language: Language; switched: boolean; detected: (string | null)[] };

/**
 * Switch only when EVERY usable sample clearly heard the OTHER supported language.
 * Anything else — samples disagree, no usable sample, or a language we don't support
 * (Hindi/Assamese can be how Whisper hears regional Bangla) — keeps the user's choice.
 */
export function decideLanguage(requested: Language, samples: LanguageSample[]): LanguageDecision {
  const usable = samples.filter((s) => s.usable);
  const detected = samples.map((s) => s.detected);
  if (usable.length === 0) return { language: requested, switched: false, detected };
  const langs = usable.map((s) => toSupportedLanguage(s.detected));
  const first = langs[0];
  const unanimous = first != null && langs.every((l) => l === first);
  if (unanimous && first !== requested) return { language: first, switched: true, detected };
  return { language: requested, switched: false, detected };
}

/** Cuts the samples from the audio file (stream copy — instant) and asks Whisper for each. */
export async function sampleLanguage(args: {
  audioFile: string;
  durationMs: number;
  workDir: string;
  model: string;
  signal?: AbortSignal;
}): Promise<LanguageSample[]> {
  const out: LanguageSample[] = [];
  for (const [i, start] of sampleStarts(args.durationMs).entries()) {
    const file = path.join(args.workDir, `lang-sample-${i}.ogg`);
    await runTool(
      env.FFMPEG_PATH,
      ["-hide_banner", "-nostdin", "-y", "-ss", String(start), "-t", String(SAMPLE_SEC), "-i", args.audioFile, "-c", "copy", file],
      { timeoutMs: 60_000, signal: args.signal, captureStdout: false },
    );
    const { result } = await transcribeWithGroq({ file, model: args.model, words: false, signal: args.signal, timeoutMs: 90_000 });
    out.push(readSample(result));
  }
  return out;
}
