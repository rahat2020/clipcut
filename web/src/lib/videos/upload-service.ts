/**
 * Upload → video lifecycle. Everything it needs (Cloudinary config, user, settings,
 * request info) is passed in, so route handlers and scripts/upload-smoke-test.ts share it.
 * No `server-only`, no env import.
 */
import { Types } from "mongoose";

import {
  ACTIVE_VIDEO_STATUSES,
  AppError,
  isDuplicateKeyError,
  newRunId,
  ownedBy,
  PERMISSION_TERMS_VERSION,
  STAGE_NAMES,
  Video,
  videoWasCharged,
  type PlanLimits,
  type SettingsOf,
  type VideoDoc,
} from "@/shared";

import {
  createUploadTicket,
  deleteSourceVideo,
  deleteVideoDataFiles,
  deleteVideoRenders,
  inspectUploadedVideo,
  signedThumbnailUrl,
  sourcePublicId,
  type CloudinaryConfig,
  type UploadTicket,
} from "../uploads/cloudinary-core";
import { assertUploadAllowed, assertUploadsOpen, titleFromFilename } from "../uploads/rules";
import type { FinalizeUploadInput, RequestUploadInput } from "./schemas";

type ServiceUser = {
  _id: Types.ObjectId;
  quota?: { periodStart?: Date | null; minutesUsed?: number | null } | null;
};

export type UploadContext = {
  cfg: CloudinaryConfig;
  user: ServiceUser;
  limits: PlanLimits;
  system: SettingsOf<"system">;
  request?: { ip?: string; userAgent?: string };
  now?: Date;
};

export type VideoWithId = VideoDoc & { _id: Types.ObjectId };

/** Videos holding one of the user's concurrent-job slots (deleted ones don't count). */
export function countActiveJobs(userId: Types.ObjectId): Promise<number> {
  return Video.countDocuments({ userId, status: { $in: [...ACTIVE_VIDEO_STATUSES] }, deletedAt: null });
}

/**
 * Step 1: quick checks with the browser's numbers, then a signed ticket for one upload.
 * The video id is allocated here and baked into the Cloudinary public id.
 */
export async function requestUpload(ctx: UploadContext, input: RequestUploadInput): Promise<UploadTicket> {
  assertUploadsOpen(ctx.system);
  assertUploadAllowed({
    user: ctx.user,
    limits: ctx.limits,
    facts: { bytes: input.sizeBytes, durationMs: input.durationMs },
    activeJobs: await countActiveJobs(ctx.user._id),
    now: ctx.now,
  });
  return createUploadTicket(ctx.cfg, {
    userId: String(ctx.user._id),
    videoId: new Types.ObjectId().toHexString(),
    now: ctx.now,
  });
}

/**
 * Step 2: the file is in Cloudinary. Re-check everything with Cloudinary's own numbers,
 * then create the video (status "queued"). Idempotent: finalizing the same upload twice
 * returns the existing video. A rejected upload's file is deleted.
 */
export async function finalizeUpload(
  ctx: UploadContext,
  input: FinalizeUploadInput,
): Promise<{ video: VideoWithId; created: boolean }> {
  const userId = ctx.user._id;
  const videoId = new Types.ObjectId(input.videoId);

  const existing = await Video.findOne({ _id: videoId, ...ownedBy(ctx.user) }).lean<VideoWithId>();
  if (existing) return { video: existing, created: false };

  assertUploadsOpen(ctx.system);
  const publicId = sourcePublicId(ctx.cfg, String(userId), input.videoId);
  const asset = await inspectUploadedVideo(ctx.cfg, publicId);
  if (!asset) throw new AppError("UPLOAD_NOT_FOUND");

  const reject = async (err: AppError): Promise<never> => {
    await deleteSourceVideo(ctx.cfg, publicId);
    throw err;
  };
  if (!asset.hasVideo || asset.durationMs <= 0) await reject(new AppError("NOT_A_VIDEO"));
  if (!asset.hasAudio) await reject(new AppError("NO_AUDIO_TRACK"));
  try {
    assertUploadAllowed({
      user: ctx.user,
      limits: ctx.limits,
      facts: { bytes: asset.bytes, durationMs: asset.durationMs },
      activeJobs: await countActiveJobs(userId),
      now: ctx.now,
    });
  } catch (err) {
    if (err instanceof AppError) await reject(err);
    throw err;
  }

  const now = ctx.now ?? new Date();
  try {
    const doc = await Video.create({
      _id: videoId,
      userId,
      clientRequestId: input.videoId,
      title: titleFromFilename(input.originalFilename),
      language: input.language,
      source: {
        type: "upload",
        originalFilename: input.originalFilename,
        sizeBytes: asset.bytes,
        cloudinary: { publicId, format: asset.format, bytes: asset.bytes },
      },
      permission: {
        confirmedAt: now,
        termsVersion: PERMISSION_TERMS_VERSION,
        ip: ctx.request?.ip,
        userAgent: ctx.request?.userAgent,
      },
      media: {
        durationMs: asset.durationMs,
        width: asset.width ?? undefined,
        height: asset.height ?? undefined,
        fps: asset.fps ?? undefined,
        hasAudio: asset.hasAudio,
        videoCodec: asset.videoCodec ?? undefined,
        audioCodec: asset.audioCodec ?? undefined,
      },
      options: { intent: input.intent },
      // The worker's dispatcher gives it a run id and queues it within seconds (D35).
      status: "queued",
      thumbnailUrl: signedThumbnailUrl(ctx.cfg, publicId, asset.durationMs),
    });
    return { video: doc.toObject() as VideoWithId, created: true };
  } catch (err) {
    // A double-submitted finalize raced us: the other request created it.
    if (!isDuplicateKeyError(err)) throw err;
    const raced = await Video.findOne({ _id: videoId, ...ownedBy(ctx.user) }).lean<VideoWithId>();
    if (!raced) throw err;
    return { video: raced, created: false };
  }
}

/**
 * User presses Retry on a failed video: back to `queued` under a new run id, so the
 * worker's dispatcher picks it up and any old job for it can no longer write.
 * Finished stages stay finished; the failed/interrupted ones start over. The same
 * minutes-left and one-at-a-time rules as a new upload apply.
 */
export async function retryVideo(ctx: Pick<UploadContext, "user" | "limits" | "now">, videoId: string): Promise<void> {
  const _id = new Types.ObjectId(videoId);
  const video = await Video.findOne({ _id, ...ownedBy(ctx.user), deletedAt: null })
    .select({ status: 1, error: 1, media: 1, source: 1, retention: 1, pipeline: 1 })
    .lean<VideoWithId>();
  if (!video) throw new AppError("NOT_FOUND");
  if (video.status !== "failed") {
    throw new AppError("CONFLICT", { message: "Only a video that failed can be retried." });
  }
  if (video.error && video.error.retryable === false) {
    throw new AppError("CONFLICT", { message: "Trying again won't help with this video. Please upload a different file." });
  }
  if (video.retention?.assetsDeletedAt) throw new AppError("MEDIA_EXPIRED");

  assertUploadAllowed({
    user: ctx.user,
    limits: ctx.limits,
    facts: { bytes: video.source?.sizeBytes ?? 0, durationMs: video.media?.durationMs ?? null },
    activeJobs: await countActiveJobs(ctx.user._id),
    // A video that was already charged is never refused for lack of minutes (Step 17).
    alreadyCharged: await videoWasCharged(_id),
    now: ctx.now,
  });

  const resetStages: Record<string, unknown> = {};
  for (const name of STAGE_NAMES) {
    const status = video.pipeline?.stages?.[name]?.status;
    if (status === "failed" || status === "running") {
      resetStages[`pipeline.stages.${name}.status`] = "pending";
      resetStages[`pipeline.stages.${name}.progress`] = 0;
    }
  }
  const res = await Video.updateOne(
    { _id, ...ownedBy(ctx.user), deletedAt: null, status: "failed" },
    {
      $set: { status: "queued", "pipeline.runId": newRunId(), "pipeline.recoveries": 0, "pipeline.quotaWaits": 0, ...resetStages },
      $unset: { error: 1, "retention.finishedAt": 1, "pipeline.jobId": 1, "pipeline.heartbeatAt": 1, "pipeline.waitUntil": 1 },
    },
  );
  if (res.modifiedCount !== 1) throw new AppError("CONFLICT");
}

/**
 * User deletes a video: hidden at once (soft delete), an unfinished one is canceled,
 * and its files (source, audio, rendered clips, transcript and clip-selection JSON) are removed from Cloudinary. If that removal fails, the cleanup
 * job (Step 17) retries it — `retention.assetsDeletedAt` stays unset until it succeeds.
 */
export async function deleteVideo(ctx: Pick<UploadContext, "cfg" | "user" | "now">, videoId: string): Promise<void> {
  const now = ctx.now ?? new Date();
  const _id = new Types.ObjectId(videoId);
  const video = await Video.findOne({ _id, ...ownedBy(ctx.user), deletedAt: null })
    .select({ status: 1, source: 1, audio: 1, currentTranscriptId: 1, currentAnalysisRunId: 1 })
    .lean<VideoWithId>();
  if (!video) throw new AppError("NOT_FOUND");

  const active = (ACTIVE_VIDEO_STATUSES as readonly string[]).includes(video.status);
  await Video.updateOne(
    { _id, ...ownedBy(ctx.user), deletedAt: null },
    { $set: { deletedAt: now, ...(active ? { status: "canceled" } : {}) } },
  );

  // Source (uploads only), extracted audio, transcript and analysis files. YouTube sources are never stored.
  const assets = [video.source?.cloudinary?.publicId, video.audio?.publicId].filter((id): id is string => !!id);
  const results = await Promise.all([
    ...assets.map((id) => deleteSourceVideo(ctx.cfg, id)),
    ...(video.currentTranscriptId || video.currentAnalysisRunId ? [deleteVideoDataFiles(ctx.cfg, String(ctx.user._id), videoId)] : []),
    ...(video.currentAnalysisRunId ? [deleteVideoRenders(ctx.cfg, String(ctx.user._id), videoId)] : []),
  ]);
  if (results.every(Boolean)) {
    await Video.updateOne({ _id }, { $set: { "retention.assetsDeletedAt": new Date() } });
  }
}
