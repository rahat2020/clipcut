import { z } from "zod";

import { AI_PROVIDERS, DEFAULT_PLAN, LANGUAGES, type SettingsGroup } from "../enums";

/**
 * Shape and defaults of every admin-tunable setting (docs/SCHEMA.md §3.9).
 *
 * Rules that keep old and new code compatible:
 * - Every field has a default, so `schema.parse({})` returns a complete, valid value and
 *   the app boots on an empty database.
 * - Nested objects use `.prefault({})`, NOT `.default({})`: in zod 4, `.default()` returns
 *   the default as-is without filling inner defaults (verified 2026-09-28).
 * - Unknown keys are stripped, so older code reading settings written by newer code works.
 *
 * Bump SETTINGS_SCHEMA_VERSION when a change needs a migration (renames, not additions).
 */
export const SETTINGS_SCHEMA_VERSION = 1;

const provider = z.enum(AI_PROVIDERS);

const fallbackModel = z.object({ provider, model: z.string().min(1) });

/**
 * Tried in order after the main model (busy, over its daily quota, unusable answer). Each
 * Gemini model has its OWN free daily quota (2.5-flash: 20 a day per Google's 429 on
 * 2026-09-30; Flash-Lite ≈ 500 per third-party guides, D43) — more models = more videos a
 * day. Groq last: its 8k tokens/minute only fits short videos.
 */
const DEFAULT_TEXT_FALLBACKS = [
  { provider: "gemini" as const, model: "gemini-3-flash-preview" },
  { provider: "gemini" as const, model: "gemini-3.1-flash-lite" },
  { provider: "groq" as const, model: "openai/gpt-oss-120b" },
];
const OLD_DEFAULT_FALLBACK = { provider: "groq", model: "openai/gpt-oss-120b" };

/**
 * A task with a fallback chain. Stored settings from before 2026-09-30 have one `fallback`
 * (object or null) instead of `fallbacks`: read as a one-item chain if an admin changed it,
 * else the new default chain applies. The next save writes `fallbacks` (SCHEMA.md §6).
 */
function taskSchema(defaults: { model: string; temperature: number; promptVersion: string }) {
  return z.preprocess(
    (raw) => {
      if (!raw || typeof raw !== "object" || "fallbacks" in raw || !("fallback" in raw)) return raw;
      const { fallback, ...rest } = raw as { fallback?: unknown };
      const custom = JSON.stringify(fallback) !== JSON.stringify(OLD_DEFAULT_FALLBACK);
      return custom ? { ...rest, fallbacks: fallback ? [fallback] : [] } : rest;
    },
    z.object({
      provider: provider.default("gemini"),
      model: z.string().min(1).default(defaults.model),
      temperature: z.number().min(0).max(2).default(defaults.temperature),
      promptVersion: z.string().min(1).default(defaults.promptVersion),
      enabled: z.boolean().default(true),
      fallbacks: z.array(fallbackModel).max(5).default(DEFAULT_TEXT_FALLBACKS),
    }),
  );
}

// ── ai ───────────────────────────────────────────────────────

export const aiSettingsSchema = z.object({
  transcription: z
    .object({
      provider: z.literal("groq").default("groq"),
      /**
       * whisper-large-v3. Compared on a real Bangla podcast (Step 7, 2026-09-28): -turbo
       * produced mostly nonsense words and skipped 55 s of speech — don't use it for Bangla.
       */
      model: z.string().min(1).default("whisper-large-v3"),
      enabled: z.boolean().default(true),
      /**
       * Text from Gemini, piece by piece, for these languages (D42). Whisper's Bangla was
       * mostly nonsense on real videos (2026-09-29/30); Gemini's was clean. Whisper stays
       * for the others and is the fallback when every Gemini model fails.
       */
      gemini: z
        .object({
          languages: z.array(z.enum(LANGUAGES)).default(["bn"]),
          /**
           * Tried in order; each has its own free daily quota (D43). Only models that keep
           * the pieces in order belong here: gemini-3.5-flash-lite shifted text between pieces (D42).
           */
          models: z.array(z.string().min(1)).min(1).max(5).default(["gemini-3-flash-preview", "gemini-3.1-flash-lite", "gemini-2.5-flash"]),
          /**
           * Audio per request; two requests run at once. 5 min: answers in ~30–90 s and a
           * failure loses little. 10 min took up to 2 min per try (2026-09-30).
           */
          batchMinutes: z.number().int().min(1).max(30).default(5),
        })
        .prefault({}),
    })
    .prefault({}),

  /**
   * 2.5-flash: answers reliably on the free tier (Step 9, 2026-09-29; 3.5+ often 503).
   * Compare models with the eval set (Step 8/11), not by version number.
   */
  clipSelection: taskSchema({ model: "gemini-2.5-flash", temperature: 0.3, promptVersion: "clip-select@1" }).prefault({}),

  copyWriting: taskSchema({ model: "gemini-2.5-flash", temperature: 0.7, promptVersion: "copy@4" }).prefault({}),

  /**
   * Our own ceilings, kept below each provider's free tier so we never get throttled or
   * banned. Starting values are conservative guesses — verify against the providers'
   * rate-limit headers in Steps 7 and 9, then tune in the admin panel.
   */
  dailyCaps: z
    .object({
      groqAudioMinutes: z.number().int().min(0).default(300),
      groqRequests: z.number().int().min(0).default(500),
      geminiRequests: z.number().int().min(0).default(200),
    })
    .prefault({}),
});

// ── limits ───────────────────────────────────────────────────

/** Cloudinary free tier rejects video files over 100 MB, so no plan may exceed it. */
export const MAX_FILE_MB_HARD_CAP = 100;

export const planLimitsSchema = z.object({
  monthlyMinutes: z.number().int().min(0).default(60),
  maxFileMB: z.number().int().min(1).max(MAX_FILE_MB_HARD_CAP).default(MAX_FILE_MB_HARD_CAP),
  maxDurationMin: z.number().int().min(1).max(180).default(60),
  concurrentJobs: z.number().int().min(1).max(10).default(1),
  maxClipsPerVideo: z.number().int().min(1).max(50).default(10),
  /** "Find new clips" requests per video (Step 14). Each is one AI call; no minutes are charged. */
  clipRequestsPerVideo: z.number().int().min(0).max(50).default(3),
  /** "Write again" / Banglish switches per video (Step 15). Each is one or two AI calls. */
  copyRequestsPerVideo: z.number().int().min(0).max(100).default(10),
  allowYoutube: z.boolean().default(true),
});
export type PlanLimits = z.infer<typeof planLimitsSchema>;

export const limitsSettingsSchema = z.object({
  plans: z
    .record(z.string().min(1), planLimitsSchema)
    .default({ [DEFAULT_PLAN]: planLimitsSchema.parse({}) })
    .refine((plans) => DEFAULT_PLAN in plans, { message: `plan "${DEFAULT_PLAN}" must exist` }),
});

// ── retention ────────────────────────────────────────────────

export const retentionSettingsSchema = z.object({
  /** Days a video's source and clips are kept, counted from when processing ended. */
  plans: z
    .record(z.string().min(1), z.object({ days: z.number().int().min(1).max(365) }))
    .default({ [DEFAULT_PLAN]: { days: 7 } })
    .refine((plans) => DEFAULT_PLAN in plans, { message: `plan "${DEFAULT_PLAN}" must exist` }),
  /** No file is deleted sooner than this after a retention change (0 = no grace). */
  graceHours: z.number().int().min(0).max(168).default(24),
  /** Set automatically by the settings service whenever any plan's `days` changes. */
  changedAt: z.coerce.date().nullable().default(null),
  purgeSoftDeletedAfterDays: z.number().int().min(1).max(365).default(30),
});

// ── system ───────────────────────────────────────────────────

export const systemSettingsSchema = z.object({
  maintenanceMode: z.boolean().default(false),
  maintenanceMessage: z.string().max(500).default(""),
  uploadsEnabled: z.boolean().default(true),
  /**
   * Kill switch for the worker: when false, queued videos wait (nothing is lost) and
   * running jobs finish. Uploads stay open unless `uploadsEnabled` is also false.
   */
  processingEnabled: z.boolean().default(true),
  /** Videos one worker processes at once. Read when the worker starts. */
  workerConcurrency: z.number().int().min(1).max(4).default(1),
  /** The YouTube kill switch (docs/DECISIONS.md D25). */
  youtubeEnabled: z.boolean().default(true),
  signupsEnabled: z.boolean().default(true),
  /** The cleanup job (Step 17): deletes expired / abandoned files. Off = nothing is deleted by the worker. */
  cleanupEnabled: z.boolean().default(true),
  /** The daily database backup to Cloudinary (Step 17, D53). Off = the worker makes none. */
  backupEnabled: z.boolean().default(true),
  /** Clip rendering (Step 12). */
  render: z
    .object({
      /** The pipeline renders this many of the best clips; the rest render when the user asks. 0 = none. */
      autoRenderTop: z.number().int().min(0).max(10).default(3),
      /** Tallest YouTube video downloaded. 1080 → sharp 9:16 crops; 720 → faster downloads, softer clips. */
      youtubeMaxHeight: z.union([z.literal(720), z.literal(1080)]).default(1080),
      /** x264 quality (lower = better, bigger) and speed. */
      crf: z.number().int().min(16).max(30).default(21),
      preset: z.enum(["ultrafast", "superfast", "veryfast", "faster", "fast", "medium"]).default("veryfast"),
    })
    .prefault({}),
});

// ── registry ─────────────────────────────────────────────────

export const SETTINGS_SCHEMAS = {
  ai: aiSettingsSchema,
  limits: limitsSettingsSchema,
  retention: retentionSettingsSchema,
  system: systemSettingsSchema,
} as const satisfies Record<SettingsGroup, z.ZodType>;

export type SettingsOf<G extends SettingsGroup> = z.infer<(typeof SETTINGS_SCHEMAS)[G]>;
export type AiSettings = SettingsOf<"ai">;
export type LimitsSettings = SettingsOf<"limits">;
export type RetentionSettings = SettingsOf<"retention">;
export type SystemSettings = SettingsOf<"system">;

/** Complete default value for a group. */
export function defaultSettings<G extends SettingsGroup>(group: G): SettingsOf<G> {
  return SETTINGS_SCHEMAS[group].parse({}) as SettingsOf<G>;
}
