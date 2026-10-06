import { env } from "../../config/env";
import { AppError } from "../../shared";
import { parseGroqDuration } from "../transcription/groq";
import { postJson } from "./http";
import type { JsonRequest, LlmResult } from "./llm";

/**
 * One Groq chat-completions call (OpenAI-compatible) with a strict JSON schema — the
 * fallback when Gemini is down (D27: openai/gpt-oss-120b).
 *
 * Free-tier fact seen on 2026-09-29: gpt-oss-120b allows 8,000 tokens per minute, so the
 * fallback only works for short videos; a long transcript gets 413 and we move on.
 */

const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

type ChatResponse = {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
};

export async function callGroqChat(model: string, request: JsonRequest, signal: AbortSignal | undefined): Promise<LlmResult> {
  if (request.audio?.length) {
    throw new AppError("INTERNAL", { message: "This AI model can't listen to audio.", details: { provider: "groq", model }, retryable: false });
  }
  const { res, bodyText, latencyMs } = await postJson(ENDPOINT, {
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: {
      model,
      temperature: request.temperature,
      max_completion_tokens: request.maxOutputTokens,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.prompt },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: request.schemaName, strict: true, schema: request.schema },
      },
    },
    timeoutMs: request.timeoutMs,
    signal,
  });

  if (!res.ok) throw groqError(res, bodyText);

  let body: ChatResponse;
  try {
    body = JSON.parse(bodyText) as ChatResponse;
  } catch (cause) {
    throw new AppError("AI_OUTPUT_INVALID", { cause, details: { provider: "groq", body: bodyText.slice(0, 200) } });
  }
  const choice = body.choices?.[0];
  const finishReason = choice?.finish_reason ?? null;
  if (!choice || finishReason !== "stop") {
    throw new AppError("AI_OUTPUT_INVALID", { details: { provider: "groq", finishReason } });
  }
  return {
    text: choice.message?.content ?? "",
    usage: {
      inputTokens: body.usage?.prompt_tokens,
      outputTokens: body.usage?.completion_tokens,
      thinkingTokens: body.usage?.completion_tokens_details?.reasoning_tokens,
    },
    latencyMs,
    finishReason,
    raw: body,
  };
}

function groqError(res: Response, bodyText: string): AppError {
  let message = bodyText.slice(0, 300);
  let code: string | undefined;
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: string; code?: string } };
    message = parsed.error?.message?.slice(0, 300) ?? message;
    code = parsed.error?.code;
  } catch {
    // keep the raw start
  }
  const status = res.status;
  const details: Record<string, unknown> = { provider: "groq", status, message, code };

  if (status === 413) {
    details.noRetry = true;
    details.tooLarge = true; // says nothing about quota: doesn't stop the video from waiting for Gemini
    return new AppError("AI_UNAVAILABLE", { message: "This transcript is too long for the fallback AI model.", details });
  }
  if (status === 429) {
    if (/per day|\bTPD\b|\bRPD\b/i.test(message)) {
      details.noRetry = true;
      details.quotaDay = true;
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    details.retryAfterSec = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : parseGroqDuration(res.headers.get("x-ratelimit-reset-tokens"));
    return new AppError("AI_UNAVAILABLE", { details });
  }
  if (status >= 500) return new AppError("AI_UNAVAILABLE", { details });
  // The model's answer broke the schema (Groq validates strict JSON itself).
  if (status === 400 && code === "json_validate_failed") return new AppError("AI_OUTPUT_INVALID", { details });
  if (status === 401 || status === 403) {
    return new AppError("INTERNAL", { message: "The AI service isn't configured correctly.", details, retryable: false });
  }
  return new AppError("INTERNAL", { details, retryable: false });
}
