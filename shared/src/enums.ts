/**
 * Every fixed set of values used in the database.
 *
 * Adding a value is safe only if readers are deployed first and handle unknown
 * values with a default branch (docs/SCHEMA.md §6.1).
 */

/** Spoken / written language (ISO 639-1). */
export const LANGUAGES = ["bn", "en"] as const;
export type Language = (typeof LANGUAGES)[number];

/** Writing system (ISO 15924): Bangla script vs Banglish in Latin letters. */
export const SCRIPTS = ["Beng", "Latn"] as const;
export type Script = (typeof SCRIPTS)[number];

export const USER_ROLES = ["user", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ["active", "suspended"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** Plans are strings so new ones can be added from the admin panel; "free" always exists. */
export const DEFAULT_PLAN = "free";

export const SOURCE_TYPES = ["upload", "youtube", "direct_url"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const VIDEO_STATUSES = ["draft", "queued", "processing", "ready", "failed", "canceled"] as const;
export type VideoStatus = (typeof VIDEO_STATUSES)[number];

/** Videos that occupy one of the user's concurrent-job slots. */
export const ACTIVE_VIDEO_STATUSES = ["queued", "processing"] as const satisfies readonly VideoStatus[];

/**
 * Version of the "I own this video or have permission to use it" wording, stored on each
 * video's `permission` record. Bump it when that wording or the terms behind it change.
 */
export const PERMISSION_TERMS_VERSION = "2026-09-28";

/** Statuses after which nothing more happens to a video until the user acts. */
export const TERMINAL_VIDEO_STATUSES = ["ready", "failed", "canceled"] as const satisfies readonly VideoStatus[];

/** Pipeline stages in execution order. */
export const STAGE_NAMES = ["ingest", "audio", "transcribe", "analyze", "copy", "render"] as const;
export type StageName = (typeof STAGE_NAMES)[number];

/**
 * What a long-running stage is doing right now, reported live as `pipeline.activity`:
 * a download (bytes, speed, time left) or waiting for an AI provider's rate limit.
 */
export const ACTIVITY_KINDS = ["download_upload", "download_youtube", "waiting_transcription"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** Below this a download counts as slow and the UI says so (≈ 4 Mbit/s). */
export const SLOW_TRANSFER_BYTES_PER_SEC = 512 * 1024;

export const STAGE_STATUSES =["pending", "running", "done", "failed", "skipped"] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

/** What the clips should focus on. New values are additive (old videos keep theirs). */
export const CLIP_INTENTS = ["best", "educational", "funny", "emotional", "custom", "sports", "news", "interview", "motivational"] as const;
export type ClipIntent = (typeof CLIP_INTENTS)[number];

export const ASPECT_RATIOS = ["9:16", "1:1", "16:9"] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export const TRANSCRIPT_KINDS = ["asr", "user_edit", "transliteration"] as const;
export type TranscriptKind = (typeof TRANSCRIPT_KINDS)[number];

export const ANALYSIS_KINDS = ["initial", "regenerate", "search"] as const;

/** A user's "Find new clips" request (Step 14): waiting/running → how it ended. */
export const CLIP_REQUEST_STATUSES = ["pending", "done", "no_moments", "failed"] as const;
export type ClipRequestStatus = (typeof CLIP_REQUEST_STATUSES)[number];
export type AnalysisKind = (typeof ANALYSIS_KINDS)[number];

export const RUN_STATUSES = ["running", "done", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const CLIP_ORIGINS = ["ai", "manual"] as const;
export type ClipOrigin = (typeof CLIP_ORIGINS)[number];

export const CLIP_STATUSES = ["suggested", "approved", "rejected"] as const;
export type ClipStatus = (typeof CLIP_STATUSES)[number];

/**
 * What kind of moment the AI thinks a clip is. The AI's answer is mapped onto this
 * list before saving; anything unrecognised becomes "other".
 */
export const MOMENT_TYPES = ["hook", "insight", "story", "qa", "emotional", "educational", "funny", "other"] as const;
export type MomentType = (typeof MOMENT_TYPES)[number];

export const RENDER_STATUSES = ["queued", "rendering", "ready", "failed"] as const;
export type RenderStatus = (typeof RENDER_STATUSES)[number];

export const USAGE_TYPES = ["transcribe", "render", "ai_tokens"] as const;
export type UsageType = (typeof USAGE_TYPES)[number];

export const USAGE_UNITS = ["minutes", "count", "tokens"] as const;
export type UsageUnit = (typeof USAGE_UNITS)[number];

export const AI_PROVIDERS = ["groq", "gemini"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const SETTINGS_GROUPS = ["ai", "limits", "retention", "system"] as const;
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];

/** Caption style ids are strings so code presets ("preset:…") and future brand kits can coexist. */
export const DEFAULT_CAPTION_STYLE_ID = "preset:bold";
