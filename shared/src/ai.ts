/**
 * Prompt versions the worker knows, per AI task. The worker's prompt registries must
 * cover exactly these (a type check in worker/src/services/clips/prompt.ts), and the
 * admin panel only offers these — so a setting can never name a prompt that doesn't exist.
 * Newest last. Never remove a version that analysis_runs rows still reference.
 */
export const PROMPT_VERSIONS = {
  clipSelection: ["clip-select@1"],
  copyWriting: ["copy@1", "copy@2", "copy@3"],
  /** Banglish captions (Step 15); not a setting — changes with the code, like snapping rules. */
  transliteration: ["banglish@1"],
} as const;

export type ClipSelectPromptVersion = (typeof PROMPT_VERSIONS.clipSelection)[number];

export function isClipSelectPromptVersion(v: string): v is ClipSelectPromptVersion {
  return (PROMPT_VERSIONS.clipSelection as readonly string[]).includes(v);
}

export const LATEST_CLIP_SELECT_PROMPT: ClipSelectPromptVersion = PROMPT_VERSIONS.clipSelection.at(-1)!;

/** Daily AI usage counters in Redis (docs/SCHEMA.md §3.11), checked against settings.ai.dailyCaps. */
export const AI_CAP_METRICS = ["groq:audioSeconds", "groq:requests", "gemini:requests"] as const;
export type AiCapMetric = (typeof AI_CAP_METRICS)[number];

/** `ai:<provider>:<metric>:<YYYY-MM-DD UTC>`. `prefix` is for tests. */
export function aiCapKey(metric: AiCapMetric, now = new Date(), prefix = "ai"): string {
  return `${prefix}:${metric}:${now.toISOString().slice(0, 10)}`;
}
