/**
 * Admin: AI models page — live model lists, a one-request "Test", and saving the `ai`
 * settings group. Keys are passed in (web's optional GEMINI_API_KEY / GROQ_API_KEY) and
 * never returned or logged. The worker makes every real AI call with its own copies.
 */
import { z } from "zod";

import {
  AppError,
  isClipSelectPromptVersion,
  PROMPT_VERSIONS,
  updateSettings,
  type AiProvider,
  type AuditActor,
  type SettingsSnapshot,
} from "@/shared";

export type AiKeys = { gemini?: string; groq?: string };

export type ModelList = { ok: true; models: string[] } | { ok: false; reason: string };

/** Speech-to-text models vs text models (clip picking, copy writing). */
export type ModelUse = "transcription" | "text";

const LIST_TTL_MS = 10 * 60_000;
const listCache = new Map<string, { value: ModelList; until: number }>();

// Not usable for our tasks: speech output, images, embeddings, agents, guards.
const GEMINI_SKIP = /tts|image|embedding|robotics|computer-use|live|native-audio|transcribe|aqa|gemma/i;
const GROQ_TEXT_SKIP = /whisper|guard|tts|playai|orpheus|distil/i;

/** Models the provider offers for this use, newest-looking first. Cached 10 minutes. */
export async function listModels(provider: AiProvider, use: ModelUse, keys: AiKeys): Promise<ModelList> {
  const key = provider === "gemini" ? keys.gemini : keys.groq;
  if (!key) return { ok: false, reason: `${provider === "gemini" ? "GEMINI_API_KEY" : "GROQ_API_KEY"} isn't set in web/.env.local` };
  const cacheKey = `${provider}:${use}`;
  const hit = listCache.get(cacheKey);
  if (hit && hit.until > Date.now()) return hit.value;

  let value: ModelList;
  try {
    if (provider === "gemini") {
      const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", {
        headers: { "x-goog-api-key": key },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
      const models = (body.models ?? [])
        .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
        .map((m) => m.name.replace(/^models\//, ""))
        .filter((n) => n.startsWith("gemini-") && !GEMINI_SKIP.test(n));
      value = { ok: true, models: use === "transcription" ? [] : models.sort().reverse() };
    } else {
      const res = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { data?: { id: string; active?: boolean }[] };
      const ids = (body.data ?? []).filter((m) => m.active !== false).map((m) => m.id);
      const models = use === "transcription" ? ids.filter((id) => /whisper/i.test(id)) : ids.filter((id) => !GROQ_TEXT_SKIP.test(id));
      value = { ok: true, models: models.sort() };
    }
  } catch (err) {
    value = { ok: false, reason: `couldn't load the list (${err instanceof Error ? err.message : "network"})` };
  }
  listCache.set(cacheKey, { value, until: Date.now() + (value.ok ? LIST_TTL_MS : 30_000) });
  return value;
}

export type ModelTestResult = { ok: boolean; latencyMs: number; message: string };

/**
 * One tiny request with the chosen model: text models must answer `{"ok":true}` as JSON
 * (the same JSON mode clip picking uses); a Whisper model is checked against the live list.
 */
export async function testModel(provider: AiProvider, model: string, use: ModelUse, keys: AiKeys): Promise<ModelTestResult> {
  const t0 = Date.now();
  const done = (ok: boolean, message: string): ModelTestResult => ({ ok, latencyMs: Date.now() - t0, message });

  if (use === "transcription") {
    const list = await listModels(provider, use, keys);
    if (!list.ok) return done(false, list.reason);
    return list.models.includes(model) ? done(true, "Model is listed and available.") : done(false, "This model isn't in the provider's list.");
  }

  const key = provider === "gemini" ? keys.gemini : keys.groq;
  if (!key) return done(false, `${provider === "gemini" ? "GEMINI_API_KEY" : "GROQ_API_KEY"} isn't set in web/.env.local`);
  const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
  const prompt = 'Reply with the JSON object {"ok": true}.';
  try {
    let res: Response;
    if (provider === "gemini") {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, responseMimeType: "application/json", responseJsonSchema: schema },
        }),
        signal: AbortSignal.timeout(45_000),
      });
    } else {
      res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_schema", json_schema: { name: "test", strict: true, schema } },
        }),
        signal: AbortSignal.timeout(45_000),
      });
    }
    const text = await res.text();
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        message += ` — ${((JSON.parse(text) as { error?: { message?: string } }).error?.message ?? "").slice(0, 200)}`;
      } catch {
        // keep the status
      }
      return done(false, message);
    }
    return done(true, "Answered with valid JSON.");
  } catch (err) {
    return done(false, err instanceof Error && err.name === "TimeoutError" ? "No answer within 45 s." : "Network error.");
  }
}

/**
 * Saves the `ai` group. Prompt versions must be ones the worker has (shared
 * PROMPT_VERSIONS); everything else is checked by the settings schema.
 */
export async function saveAiSettings(
  actor: AuditActor,
  value: unknown,
  expectedVersion: number,
): Promise<SettingsSnapshot<"ai">> {
  const v = value as { clipSelection?: { promptVersion?: string }; copyWriting?: { promptVersion?: string } } | null;
  const clip = v?.clipSelection?.promptVersion;
  if (clip !== undefined && !isClipSelectPromptVersion(clip)) {
    throw new AppError("VALIDATION_FAILED", { message: `Unknown clip-selection prompt "${clip}".` });
  }
  const copy = v?.copyWriting?.promptVersion;
  if (copy !== undefined && !(PROMPT_VERSIONS.copyWriting as readonly string[]).includes(copy)) {
    throw new AppError("VALIDATION_FAILED", { message: `Unknown copy prompt "${copy}".` });
  }
  return updateSettings("ai", value, { expectedVersion: z.number().int().min(0).parse(expectedVersion), actor });
}
