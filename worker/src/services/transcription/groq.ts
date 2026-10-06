import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { env } from "../../config/env";
import { AppError, type Language } from "../../shared";

/**
 * Groq's Whisper endpoint (OpenAI-compatible). We send the small Opus file from the audio
 * stage and ask for `verbose_json` with segment AND word timestamps, which clip-boundary
 * snapping needs (Steps 9–10).
 *
 * The full transcription always passes `language` (forced: no drifting into another
 * language or script mid-video). Leaving it out = Whisper detects the language from the
 * first 30 s — used only on short samples to check the user's choice (language.ts).
 * Temperature 0 = the most likely text, no creative guesses.
 */

const ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";

const segmentSchema = z.looseObject({
  start: z.number(),
  end: z.number(),
  text: z.string(),
  avg_logprob: z.number().optional(),
  no_speech_prob: z.number().optional(),
  compression_ratio: z.number().optional(),
});
const wordSchema = z.looseObject({ word: z.string(), start: z.number(), end: z.number() });
const responseSchema = z.looseObject({
  text: z.string().default(""),
  language: z.string().optional(),
  duration: z.number().optional(),
  segments: z.array(segmentSchema).default([]),
  words: z.array(wordSchema).default([]),
});

export type RawTranscription = z.infer<typeof responseSchema>;

export type RateLimitInfo = {
  /** Audio seconds left in the current hour / day windows, when Groq reports them. */
  remainingAudioSeconds?: number;
  remainingRequests?: number;
  retryAfterSec?: number;
  /** Seconds until the audio-seconds budget is full again ("x-ratelimit-reset-audio-seconds"). */
  resetAudioSec?: number;
};

/** Groq's reset durations: "18.5s", "7m30s", "1h2m3.5s", "250ms" → seconds. */
export function parseGroqDuration(value: string | null): number | undefined {
  if (!value) return undefined;
  let total = 0;
  let matched = false;
  for (const m of value.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    matched = true;
    const n = Number(m[1]);
    total += m[2] === "h" ? n * 3600 : m[2] === "m" ? n * 60 : m[2] === "ms" ? n / 1000 : n;
  }
  return matched ? total : undefined;
}

function readRateLimits(h: Headers): RateLimitInfo {
  const num = (name: string) => {
    const v = h.get(name);
    return v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined;
  };
  return {
    remainingAudioSeconds: num("x-ratelimit-remaining-audio-seconds"),
    remainingRequests: num("x-ratelimit-remaining-requests"),
    retryAfterSec: num("retry-after"),
    resetAudioSec: parseGroqDuration(h.get("x-ratelimit-reset-audio-seconds")),
  };
}

export async function transcribeWithGroq(args: {
  file: string;
  /** Omit to let Whisper detect the language (samples only). */
  language?: Language;
  model: string;
  /** Word timestamps cost nothing extra but aren't needed for language samples. */
  words?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ result: RawTranscription; rateLimits: RateLimitInfo; latencyMs: number }> {
  const bytes = await readFile(args.file);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "audio/ogg" }), path.basename(args.file));
  form.append("model", args.model);
  if (args.language) form.append("language", args.language);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  if (args.words !== false) form.append("timestamp_granularities[]", "word");
  form.append("temperature", "0");

  const timeout = AbortSignal.timeout(args.timeoutMs ?? 5 * 60_000);
  const signal = args.signal ? AbortSignal.any([args.signal, timeout]) : timeout;
  const t0 = Date.now();

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
      body: form,
      signal,
    });
  } catch (cause) {
    if (args.signal?.aborted) throw cause;
    throw new AppError("TRANSCRIPTION_FAILED", { cause, message: "We couldn't reach the transcription service. We'll retry." });
  }

  const rateLimits = readRateLimits(res.headers);
  const bodyText = await res.text();

  if (!res.ok) {
    // Only Groq's error message goes to the logs (details), never the key or the audio.
    const details = { status: res.status, body: bodyText.slice(0, 500), ...rateLimits };
    if (res.status === 429) {
      throw new AppError("AI_UNAVAILABLE", {
        message: "The transcription service is busy. We'll retry automatically.",
        details,
      });
    }
    if (res.status >= 500) throw new AppError("TRANSCRIPTION_FAILED", { details });
    if (res.status === 401 || res.status === 403) {
      throw new AppError("INTERNAL", { message: "Transcription isn't configured correctly.", details, retryable: false });
    }
    throw new AppError("TRANSCRIPTION_FAILED", {
      message: "The transcription service couldn't read this audio.",
      details,
      retryable: false,
    });
  }

  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch (cause) {
    throw new AppError("TRANSCRIPTION_FAILED", { cause, details: { body: bodyText.slice(0, 200) } });
  }
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) {
    throw new AppError("TRANSCRIPTION_FAILED", { details: { issues: parsed.error.issues.slice(0, 3) } });
  }
  return { result: parsed.data, rateLimits, latencyMs: Date.now() - t0 };
}
