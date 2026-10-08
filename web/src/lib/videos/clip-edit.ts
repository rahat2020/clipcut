import { Types } from "mongoose";
import { z } from "zod";

import {
  AppError,
  CAPTION_STYLES,
  captionScriptFor,
  Clip,
  CLIP_EDIT,
  CLIP_STATUSES,
  isValidClipRange,
  isVisibleClip,
  normalizeHashtags,
  oneLineText,
  ownedBy,
  POST_COPY,
  Video,
} from "@/shared";

/**
 * The user's changes to one clip (Step 13): keep / reject (with a reason), trim, framing,
 * caption style — and its post text (Step 15). Only the clip document changes; a new MP4 is a
 * separate request (render).
 * No `server-only`, no env import: scripts/review-smoke-test.ts runs it.
 */

export const clipUpdateSchema = z
  .object({
    status: z.enum(CLIP_STATUSES).optional(),
    reason: z.string().trim().max(500).optional(),
    startMs: z.number().int().min(0).optional(),
    endMs: z.number().int().min(0).optional(),
    cropOffsetX: z.number().min(-1).max(1).optional(),
    captionStyleId: z.string().refine((id) => id in CAPTION_STYLES, "unknown caption style").optional(),
    /** Auto zoom on or off for this clip (render@3). */
    autoZoom: z.boolean().optional(),
    /** The post text as the user edited it (all four fields together). */
    copy: z
      .object({
        title: z.string().trim().min(1, "A title is needed.").max(POST_COPY.titleMaxChars),
        hook: z.string().trim().max(POST_COPY.hookMaxChars),
        description: z.string().trim().max(POST_COPY.descriptionMaxChars),
        hashtags: z.array(z.string().max(POST_COPY.hashtagMaxChars + 1)).max(20),
      })
      .optional(),
  })
  .refine((v) => (v.startMs === undefined) === (v.endMs === undefined), "startMs and endMs go together")
  .refine((v) => Object.values(v).some((x) => x !== undefined), "nothing to change");

export type ClipUpdateInput = z.infer<typeof clipUpdateSchema>;

type EditUser = { _id: Types.ObjectId };

export async function updateClip(ctx: { user: EditUser; now?: Date }, clipId: string, input: ClipUpdateInput): Promise<void> {
  const now = ctx.now ?? new Date();
  const clip = await Clip.findOne({ _id: clipId, ...ownedBy(ctx.user), deletedAt: null })
    .select({ videoId: 1, analysisRunId: 1, keptAt: 1, startMs: 1, endMs: 1, edit: 1 })
    .lean();
  if (!clip) throw new AppError("NOT_FOUND");
  const video = await Video.findOne({ _id: clip.videoId, ...ownedBy(ctx.user), deletedAt: null })
    .select({ currentAnalysisRunId: 1, media: 1, retention: 1, language: 1, options: 1 })
    .lean();
  if (!video || !isVisibleClip(video, clip)) throw new AppError("NOT_FOUND");

  const set: Record<string, unknown> = {};
  const unset: Record<string, 1> = {};

  if (input.status) {
    set.status = input.status;
    if (input.status === "rejected") set.feedback = { ...(input.reason ? { reason: input.reason } : {}), at: now };
    else unset.feedback = 1;
  }

  const changesPixels = input.startMs !== undefined || input.cropOffsetX !== undefined || input.captionStyleId !== undefined || input.autoZoom !== undefined;
  if (changesPixels && video.retention?.assetsDeletedAt) throw new AppError("MEDIA_EXPIRED");

  if (input.startMs !== undefined && input.endMs !== undefined) {
    const videoMs = video.media?.durationMs ?? 0;
    if (!isValidClipRange(input.startMs, input.endMs, videoMs)) {
      throw new AppError("VALIDATION_FAILED", {
        message: `A clip must be ${CLIP_EDIT.minMs / 1000} s to ${CLIP_EDIT.maxMs / 60_000} min long and inside the video.`,
      });
    }
    const aiStart = clip.edit?.aiStartMs ?? clip.startMs;
    const aiEnd = clip.edit?.aiEndMs ?? clip.endMs;
    set.startMs = input.startMs;
    set.endMs = input.endMs;
    set.durationMs = input.endMs - input.startMs;
    if (input.startMs === aiStart && input.endMs === aiEnd) {
      // Back to the AI's cut: no longer counts as trimmed.
      unset["edit.aiStartMs"] = 1;
      unset["edit.aiEndMs"] = 1;
    } else if (clip.edit?.aiStartMs == null) {
      set["edit.aiStartMs"] = clip.startMs;
      set["edit.aiEndMs"] = clip.endMs;
    }
  }
  if (input.cropOffsetX !== undefined) set["edit.cropOffsetX"] = Math.round(input.cropOffsetX * 100) / 100;
  if (input.captionStyleId !== undefined) set["edit.captionStyleId"] = input.captionStyleId;
  if (input.autoZoom !== undefined) set["edit.autoZoom"] = input.autoZoom;
  if (input.copy) {
    set["copy.title"] = oneLineText(input.copy.title, POST_COPY.titleMaxChars);
    set["copy.hook"] = oneLineText(input.copy.hook, POST_COPY.hookMaxChars);
    set["copy.description"] = oneLineText(input.copy.description, POST_COPY.descriptionMaxChars);
    set["copy.hashtags"] = normalizeHashtags(input.copy.hashtags);
    set["copy.editedAt"] = now;
    // Counts as written for the video's current letters, so the copy stage leaves it alone.
    set["copy.language"] = video.language;
    set["copy.script"] = captionScriptFor({ language: video.language, captionScript: video.options?.captionScript });
  }

  await Clip.updateOne(
    { _id: clip._id, ...ownedBy(ctx.user), deletedAt: null },
    { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) },
  );
}
