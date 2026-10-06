import type { Types } from "mongoose";

/**
 * Which clips a video shows (Step 14, docs/DECISIONS.md D47): the clips of its current
 * clip-selection run, plus clips the user approved in an earlier set ("kept"). When a new
 * set arrives, approved clips get `keptAt` and stay; everything else of the old set leaves
 * the page (the rows stay for Admin → Accuracy).
 *
 * Plain values only — no models — so client code may import this file.
 */

type VideoForClips = { _id: Types.ObjectId | string; currentAnalysisRunId?: Types.ObjectId | string | null };

/** Mongo filter for the clips a video shows. Spread `ownedBy(user)` next to it for user queries. */
export function visibleClipsFilter(video: VideoForClips) {
  return {
    videoId: video._id,
    deletedAt: null,
    $or: [...(video.currentAnalysisRunId ? [{ analysisRunId: video.currentAnalysisRunId }] : []), { keptAt: { $ne: null } }],
  };
}

/** The same rule for one clip already loaded (with its `analysisRunId` and `keptAt`). */
export function isVisibleClip(
  video: Pick<VideoForClips, "currentAnalysisRunId">,
  clip: { analysisRunId?: Types.ObjectId | string | null; keptAt?: Date | null },
): boolean {
  if (clip.keptAt) return true;
  return !!video.currentAnalysisRunId && !!clip.analysisRunId && String(clip.analysisRunId) === String(video.currentAnalysisRunId);
}

/** "Find new clips" limits (the per-video count is a plan limit: clipRequestsPerVideo). */
export const CLIP_REQUEST = {
  /** A custom search ("where he talks about the final") — any language. */
  queryMinChars: 3,
  queryMaxChars: 200,
} as const;
