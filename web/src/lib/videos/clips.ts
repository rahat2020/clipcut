import "server-only";

import type { Types } from "mongoose";

import { AnalysisRun, captionStyle, Clip, visibleClipsFilter, type ClipIntent, type ClipStatus, type MomentType, type VideoDoc } from "@/shared";

/** One AI-suggested clip, as the video page shows it (client-safe, plain values). */
export type ClipView = {
  id: string;
  rank: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  /** 0–100 */
  score: number | null;
  momentType: MomentType;
  reason: string;
  transcriptText: string;
  status: ClipStatus;
  /** Why the user rejected it, if they said. */
  rejectReason: string | null;
  /** -1 … 1 (Step 13 framing). */
  cropOffsetX: number;
  captionStyleId: string;
  /** The AI's cut before the user trimmed it; null when never trimmed. */
  ai: { startMs: number; endMs: number } | null;
  /** Approved in an earlier set and kept when new clips were found (Step 14). */
  kept: boolean;
  /** Post text (Step 15); null until it's written. */
  copy: ClipCopyView | null;
  /** The user asked for it to be written again and it hasn't been yet. */
  copyPending: boolean;
  /** New cover words are being written ("Suggest words" or "Write again"). */
  coverPending: boolean;
};

export type ClipCopyView = {
  title: string;
  hook: string;
  description: string;
  hashtags: string[];
  /** Big words for the cover (copy@2+); "" for older text. */
  coverText: string;
  /** Up to 3 AI cover ideas with the word in the second colour (copy@3+); [] for older text. */
  coverOptions: { text: string; highlight: string }[];
  /** "Latn" = Banglish (or English). */
  script: "Beng" | "Latn";
  edited: boolean;
};

/** What the current set was picked for (its run's input). */
export type ClipFocusView = { intent: ClipIntent; query: string | null };

export type ClipListView = { clips: ClipView[]; model: string | null; focus: ClipFocusView | null };

/**
 * The clips the video shows (shared/clip-sets.ts): its current clip-selection run, best
 * first, then clips kept from earlier sets in time order. Filtered on the video AND its
 * owner, so a stale id can never show someone else's clips.
 */
export async function loadClips(
  video: Pick<VideoDoc, "currentAnalysisRunId" | "userId"> & { _id: Types.ObjectId },
): Promise<ClipListView | null> {
  if (!video.currentAnalysisRunId) return null;
  const filter = { videoId: video._id, userId: video.userId };
  const [run, rows] = await Promise.all([
    AnalysisRun.findOne({ _id: video.currentAnalysisRunId, ...filter }).select({ ai: 1, input: 1 }).lean(),
    Clip.find({ ...visibleClipsFilter(video), userId: video.userId })
      .select({ analysisRunId: 1, keptAt: 1, rank: 1, startMs: 1, endMs: 1, durationMs: 1, ai: 1, transcriptText: 1, status: 1, feedback: 1, edit: 1, copy: 1, copyRedoAt: 1, coverRedoAt: 1 })
      .lean(),
  ]);
  if (!run) return null;
  const current = String(video.currentAnalysisRunId);
  const isCurrent = (c: (typeof rows)[number]) => String(c.analysisRunId) === current;
  const clips = [
    ...rows.filter(isCurrent).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)),
    ...rows.filter((c) => !isCurrent(c)).sort((a, b) => a.startMs - b.startMs),
  ];
  return {
    model: run.ai?.model ?? null,
    focus: run.input?.intent ? { intent: run.input.intent, query: run.input.query ?? null } : null,
    // Numbered in the order shown (kept clips continue after the new set).
    clips: clips.map((c, i) => ({
      id: String(c._id),
      rank: i + 1,
      startMs: c.startMs,
      endMs: c.endMs,
      durationMs: c.durationMs,
      score: c.ai?.score != null ? Math.round(c.ai.score * 100) : null,
      momentType: c.ai?.momentType ?? "other",
      reason: c.ai?.reason ?? "",
      transcriptText: c.transcriptText ?? "",
      status: c.status,
      rejectReason: c.status === "rejected" ? (c.feedback?.reason ?? null) : null,
      cropOffsetX: c.edit?.cropOffsetX ?? 0,
      captionStyleId: captionStyle(c.edit?.captionStyleId).id,
      ai: c.edit?.aiStartMs != null && c.edit.aiEndMs != null ? { startMs: c.edit.aiStartMs, endMs: c.edit.aiEndMs } : null,
      kept: !isCurrent(c),
      copy: c.copy?.title
        ? {
            title: c.copy.title,
            hook: c.copy.hook ?? "",
            description: c.copy.description ?? "",
            hashtags: c.copy.hashtags ?? [],
            coverText: c.copy.coverText ?? "",
            coverOptions: (c.copy.coverOptions ?? []).map((o) => ({ text: o.text ?? "", highlight: o.highlight ?? "" })).filter((o) => o.text),
            script: c.copy.script === "Latn" ? "Latn" : "Beng",
            edited: !!c.copy.editedAt,
          }
        : null,
      copyPending: !!c.copyRedoAt,
      coverPending: !!c.copyRedoAt || !!c.coverRedoAt,
    })),
  };
}
