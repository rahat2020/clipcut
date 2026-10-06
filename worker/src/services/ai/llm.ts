import type { Logger } from "pino";

import { AppError, isAppError, type AiProvider } from "../../shared";
import { callGemini } from "./gemini";
import { callGroqChat } from "./groq-chat";
import { quotaResumeAt } from "./reset-time";

/**
 * The LLMProvider interface (D9): every clip-picking or copy-writing call goes through
 * `generateJson`, which tries the configured model, retries what's worth retrying, and
 * falls back to the next model. Each provider module only knows how to make ONE call and
 * turn its failures into AppErrors:
 *
 *   AI_UNAVAILABLE    busy / rate-limited / network — details.retryAfterSec when known,
 *                     details.noRetry when retrying the same model can't help
 *                     (daily quota used up, request too large for the model's limit)
 *   AI_OUTPUT_INVALID the model answered, but not with usable JSON (or was cut off)
 *   INTERNAL          our fault or config (bad key, bad request) — not retried
 */

/** A JSON Schema object (the subset Gemini's responseJsonSchema and Groq's strict mode both accept). */
export type JsonSchema = Record<string, unknown>;

export type LlmTarget = { provider: AiProvider; model: string };

/** Audio sent along with the prompt (Gemini only), each with a label placed before it. */
export type AudioPart = { label: string; mimeType: string; base64: string };

export type JsonRequest = {
  system: string;
  prompt: string;
  /** Audio pieces, sent before the prompt. Gemini only — Groq refuses the request. */
  audio?: AudioPart[];
  /** Turn thinking off (as far as the model allows): transcription needs none. Gemini only. */
  noThinking?: boolean;
  /** Name of the answer's shape (Groq requires one). */
  schemaName: string;
  schema: JsonSchema;
  temperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
};

export type LlmUsage = { inputTokens?: number; outputTokens?: number; thinkingTokens?: number };

export type LlmResult = {
  /** The answer text (JSON), thinking parts removed. */
  text: string;
  usage: LlmUsage;
  latencyMs: number;
  finishReason: string | null;
  /** The provider's untouched response body, for the analysis record. */
  raw: unknown;
};

export type LlmCall = (model: string, request: JsonRequest, signal: AbortSignal | undefined) => Promise<LlmResult>;

const PROVIDERS: Record<AiProvider, LlmCall> = { gemini: callGemini, groq: callGroqChat };

export type AttemptLog = { provider: AiProvider; model: string; ok: boolean; code?: string; ms: number };

/** Tries per model: the first call plus up to two retries. */
const MAX_ATTEMPTS = 3;
/** Waits between retries of the same model when the provider doesn't say how long. */
const BACKOFF_SEC = [4, 12];
/** A provider asking us to wait longer than this is treated as "try the next model". */
const MAX_INLINE_WAIT_SEC = 30;

export async function generateJson<T>(args: {
  targets: LlmTarget[];
  request: JsonRequest;
  /** Turns the answer text into a value, or throws AI_OUTPUT_INVALID. */
  parse: (text: string) => T;
  signal?: AbortSignal;
  log: Logger;
  /** Runs before every call — reserve daily caps here (may throw AI_DAILY_CAP_REACHED). */
  beforeCall?: (target: LlmTarget) => Promise<void>;
  /**
   * Calls per model before moving on (default 3). Long calls (a batch of audio) use 1: a
   * busy model answered 503 only after 60–110 s, three times in a row (2026-09-30).
   */
  attemptsPerModel?: number;
  /** Tests replace the providers and the clock. */
  call?: (target: LlmTarget, request: JsonRequest, signal: AbortSignal | undefined) => Promise<LlmResult>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): Promise<{ value: T; result: LlmResult; target: LlmTarget; attempts: AttemptLog[] }> {
  const call = args.call ?? ((t, r, s) => PROVIDERS[t.provider](t.model, r, s));
  const wait = args.sleep ?? sleep;
  const attempts: AttemptLog[] = [];
  const errors: AppError[] = [];
  if (args.targets.length === 0) throw new AppError("INTERNAL", { message: "No AI model is configured." });

  const maxAttempts = Math.max(1, args.attemptsPerModel ?? MAX_ATTEMPTS);
  for (const target of args.targets) {
    let invalidAnswers = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const t0 = Date.now();
      try {
        await args.beforeCall?.(target);
        const result = await call(target, args.request, args.signal);
        const value = args.parse(result.text);
        attempts.push({ ...target, ok: true, ms: Date.now() - t0 });
        return { value, result, target, attempts };
      } catch (err) {
        if (args.signal?.aborted) throw err;
        const appErr = isAppError(err) ? err : new AppError("INTERNAL", { cause: err });
        attempts.push({ ...target, ok: false, code: appErr.code, ms: Date.now() - t0 });
        errors.push(appErr);
        args.log.warn(
          { provider: target.provider, model: target.model, attempt, code: appErr.code, details: appErr.details },
          "AI call failed",
        );

        const waitSec = retryWaitSec(appErr, attempt, invalidAnswers);
        if (appErr.code === "AI_OUTPUT_INVALID") invalidAnswers++;
        if (waitSec === null || attempt === maxAttempts) break; // next model
        if (waitSec > 0) await wait(waitSec * 1000, args.signal);
      }
    }
  }
  throw pickFinalError(errors);
}

/** Seconds to wait before retrying the same model, or null to move on to the next one. */
function retryWaitSec(err: AppError, attempt: number, invalidAnswersSoFar: number): number | null {
  if (err.code === "AI_OUTPUT_INVALID") return invalidAnswersSoFar === 0 ? 0 : null; // one more try
  if (err.code !== "AI_UNAVAILABLE" || err.details?.noRetry) return null;
  const asked = Number(err.details?.retryAfterSec);
  const sec = Number.isFinite(asked) && asked > 0 ? asked : (BACKOFF_SEC[attempt - 1] ?? BACKOFF_SEC.at(-1)!);
  return sec <= MAX_INLINE_WAIT_SEC ? sec : null;
}

/**
 * Every model failed. Our own daily caps win only if they're the reason for everything
 * (the job then waits for tomorrow); otherwise the most recent real failure is reported,
 * and a config problem (INTERNAL) is kept non-retryable.
 */
export function pickFinalError(errors: AppError[], now = new Date()): AppError {
  // Quota gone everywhere (Google's per-day limits, our own caps; a model that merely couldn't
  // fit the transcript says nothing): AI_DAILY_CAP_REACHED, which makes the video wait until
  // `details.resumeAt` instead of failing (Step 17).
  const relevant = errors.filter((e) => e.details?.tooLarge !== true);
  const isQuota = (e: AppError) => e.code === "AI_DAILY_CAP_REACHED" || (e.code === "AI_UNAVAILABLE" && e.details?.quotaDay === true);
  if (relevant.length > 0 && relevant.every(isQuota)) {
    const resumeAt = quotaResumeAt(now, {
      gemini: relevant.some((e) => e.details?.provider === "gemini"),
      ours: relevant.some((e) => e.code === "AI_DAILY_CAP_REACHED"),
    });
    return new AppError("AI_DAILY_CAP_REACHED", { details: { resumeAt: resumeAt.toISOString() } });
  }
  const real = errors.filter((e) => e.code !== "AI_DAILY_CAP_REACHED");
  const last = real.at(-1) ?? errors.at(-1);
  return last ?? new AppError("AI_UNAVAILABLE");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}
