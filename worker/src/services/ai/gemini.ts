import { env } from "../../config/env";
import { AppError } from "../../shared";
import { parseSeconds, postJson } from "./http";
import type { JsonRequest, LlmResult } from "./llm";

/**
 * One Gemini generateContent call that must answer JSON matching `request.schema`
 * (`responseJsonSchema`, verified 2026-09-29 on gemini-2.5-flash and gemini-3-flash-preview).
 *
 * Free-tier facts seen on 2026-09-29: the newest models (3.5+) often answer 503 "high
 * demand"; 2.5-flash-lite and 2.5-pro are closed to new keys. Thinking is on by default
 * and its tokens count toward maxOutputTokens.
 */

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

type GeminiPart = { text?: string; thought?: boolean };
type GeminiResponse = {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
};
type GeminiError = {
  error?: { code?: number; message?: string; status?: string; details?: { "@type"?: string; retryDelay?: string; violations?: { quotaId?: string }[] }[] };
};

export async function callGemini(model: string, request: JsonRequest, signal: AbortSignal | undefined): Promise<LlmResult> {
  const { res, bodyText, latencyMs } = await postJson(`${BASE}/${encodeURIComponent(model)}:generateContent`, {
    headers: { "x-goog-api-key": env.GEMINI_API_KEY },
    body: {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [
        {
          role: "user",
          parts: [
            ...(request.audio ?? []).flatMap((a) => [{ text: a.label }, { inlineData: { mimeType: a.mimeType, data: a.base64 } }]),
            { text: request.prompt },
          ],
        },
      ],
      generationConfig: {
        temperature: request.temperature,
        maxOutputTokens: request.maxOutputTokens,
        responseMimeType: "application/json",
        responseJsonSchema: request.schema,
        ...(request.noThinking ? { thinkingConfig: noThinking(model) } : {}),
      },
    },
    timeoutMs: request.timeoutMs,
    signal,
  });

  if (!res.ok) throw geminiError(res.status, bodyText);

  let body: GeminiResponse;
  try {
    body = JSON.parse(bodyText) as GeminiResponse;
  } catch (cause) {
    throw new AppError("AI_OUTPUT_INVALID", { cause, details: { provider: "gemini", body: bodyText.slice(0, 200) } });
  }
  const candidate = body.candidates?.[0];
  const finishReason = candidate?.finishReason ?? null;
  const blocked = body.promptFeedback?.blockReason;
  if (blocked || !candidate) {
    // The same input is refused again by the same model — let the fallback model try.
    throw new AppError("AI_OUTPUT_INVALID", { details: { provider: "gemini", blocked: blocked ?? "no candidate" } });
  }
  if (finishReason !== "STOP") {
    throw new AppError("AI_OUTPUT_INVALID", { details: { provider: "gemini", finishReason } });
  }
  const text = (candidate.content?.parts ?? [])
    .filter((p) => !p.thought && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
  const u = body.usageMetadata;
  return {
    text,
    usage: { inputTokens: u?.promptTokenCount, outputTokens: u?.candidatesTokenCount, thinkingTokens: u?.thoughtsTokenCount },
    latencyMs,
    finishReason,
    raw: body,
  };
}

/**
 * The least thinking each family allows. Measured 2026-09-30 on 2.6 min of Bangla audio:
 * gemini-3-flash-preview thought 31k tokens (105 s) by default, 0 tokens (6.7 s) at
 * "minimal", with the same transcript. 2.5-pro can't turn thinking off (128 is its floor).
 */
function noThinking(model: string): Record<string, unknown> {
  if (/2\.5-pro/.test(model)) return { thinkingBudget: 128 };
  if (/2\.5/.test(model)) return { thinkingBudget: 0 };
  return { thinkingLevel: /pro/.test(model) ? "low" : "minimal" };
}

/** Maps an error response. Only Google's message goes into details — never the key or prompt. */
function geminiError(status: number, bodyText: string): AppError {
  let parsed: GeminiError = {};
  try {
    parsed = JSON.parse(bodyText) as GeminiError;
  } catch {
    // not JSON — keep the raw start below
  }
  const message = parsed.error?.message?.slice(0, 300) ?? bodyText.slice(0, 300);
  const details: Record<string, unknown> = { provider: "gemini", status, message };

  if (status === 429) {
    const infos = parsed.error?.details ?? [];
    details.retryAfterSec = parseSeconds(infos.find((d) => d["@type"]?.endsWith("RetryInfo"))?.retryDelay);
    const quotaIds = infos.flatMap((d) => d.violations ?? []).map((v) => v.quotaId ?? "");
    // A per-day free-tier quota won't come back for hours: don't wait, use the fallback.
    if (quotaIds.some((q) => /PerDay/i.test(q))) {
      details.noRetry = true;
      details.quotaDay = true; // every model out of quota → the video waits for the reset instead of failing
    }
    return new AppError("AI_UNAVAILABLE", { details });
  }
  if (status >= 500) return new AppError("AI_UNAVAILABLE", { details });
  if (status === 401 || status === 403) {
    return new AppError("INTERNAL", { message: "The AI service isn't configured correctly.", details, retryable: false });
  }
  if (status === 404) {
    // A retired or misspelled model name (settings.ai) — an admin must change it.
    return new AppError("INTERNAL", { message: "The configured AI model isn't available.", details, retryable: false });
  }
  if (status === 400 && /token/i.test(message)) {
    details.noRetry = true;
    details.tooLarge = true;
    return new AppError("AI_UNAVAILABLE", { message: "This transcript is too long for the AI model.", details });
  }
  return new AppError("INTERNAL", { details, retryable: false });
}
