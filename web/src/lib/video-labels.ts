import type { ClipIntent, MomentType, StageName, VideoStatus } from "@/shared";

/** What each pipeline stage is called in the UI (docs/DESIGN.md — Processing screen). */
export const STAGE_LABELS: Record<StageName, string> = {
  ingest: "Preparing video",
  audio: "Extracting audio",
  transcribe: "Transcribing",
  analyze: "Finding moments",
  copy: "Writing titles & hooks",
  render: "Rendering clips",
};

export type StatusTone = "accent" | "info" | "danger" | "neutral";

export const STATUS_DISPLAY: Record<VideoStatus, { label: string; tone: StatusTone }> = {
  draft: { label: "Draft", tone: "neutral" },
  queued: { label: "Queued", tone: "neutral" },
  processing: { label: "Processing", tone: "info" },
  ready: { label: "Ready", tone: "accent" },
  failed: { label: "Failed", tone: "danger" },
  canceled: { label: "Canceled", tone: "neutral" },
};

/**
 * A run that stopped at a stage that isn't built yet (STAGE_NOT_READY) — during development
 * the clips are there and only titles/rendering are missing. Shown as "Clips ready", not
 * "Failed". Goes away once every stage exists (Steps 12 and 15).
 */
export function isComingSoon(status: VideoStatus, errorCode: string | null | undefined): boolean {
  return status === "failed" && errorCode === "STAGE_NOT_READY";
}

/** What kind of moment the AI says a clip is. */
export const MOMENT_LABELS: Record<MomentType, string> = {
  hook: "Hook",
  insight: "Insight",
  story: "Story",
  qa: "Q&A",
  emotional: "Emotional",
  educational: "Educational",
  funny: "Funny",
  other: "Moment",
};

/** Spoken-language names for UI copy (English UI, D32). */
export const LANGUAGE_NAMES = { bn: "Bangla", en: "English" } as const;

/** What clips should focus on — the New video form and "Find new clips" (Step 14). */
export const INTENT_LABELS: Record<ClipIntent, string> = {
  best: "Best moments (recommended)",
  sports: "Sports highlights",
  news: "News & updates",
  interview: "Interviews & podcasts",
  educational: "Teaching & tips",
  funny: "Funny moments",
  emotional: "Stories & emotion",
  motivational: "Speeches & motivation",
  custom: "Something specific…",
};

/** Short form for the header: "Best moments", or the user's own words in quotes. */
export function focusLabel(focus: { intent: ClipIntent; query: string | null }): string {
  if (focus.intent === "custom" && focus.query) return `“${focus.query}”`;
  return INTENT_LABELS[focus.intent].replace(" (recommended)", "");
}
