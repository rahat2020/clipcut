import { Types } from "mongoose";
import { z } from "zod";

import {
  ACTIVE_VIDEO_STATUSES,
  AppError,
  Clip,
  getSettings,
  isExpired,
  isVisibleClip,
  newRunId,
  ownedBy,
  SCRIPTS,
  Video,
  type PlanLimits,
} from "@/shared";

import { countActiveJobs } from "./upload-service";

/**
 * Post text on request (Step 15, D48): "Write again" for one clip, "Write post text" for the
 * clips that have none, and the Banglish switch of a Bangla video. Each puts the finished video
 * back in the queue for the "copy" stage only (one AI request; rendering isn't touched), capped
 * per video by the plan (`copyRequestsPerVideo`). No minutes are charged.
 * No `server-only`, no env import: scripts/review-smoke-test.ts runs it.
 */

type RequestUser = { _id: Types.ObjectId; plan: string };
type Ctx = { user: RequestUser; limits: PlanLimits; now?: Date };

export const copyRequestSchema = z
  .object({
    clipId: z.string().regex(/^[a-f0-9]{24}$/).optional(),
    /** "cover" = new cover words only ("Suggest words", Step 15.6); the clip's other text stays. */
    part: z.enum(["all", "cover"]).default("all"),
  })
  .refine((v) => v.part === "all" || v.clipId, { message: "Cover words are asked for one clip." });
export const captionScriptSchema = z.object({ script: z.enum(SCRIPTS) });

const VIDEO_FIELDS = { status: 1, pipeline: 1, retention: 1, counts: 1, currentAnalysisRunId: 1, language: 1, options: 1 } as const;

async function loadVideo(ctx: Ctx, videoId: string) {
  const video = await Video.findOne({ _id: new Types.ObjectId(videoId), ...ownedBy(ctx.user), deletedAt: null }).select(VIDEO_FIELDS).lean();
  if (!video) throw new AppError("NOT_FOUND");
  if ((ACTIVE_VIDEO_STATUSES as readonly string[]).includes(video.status)) {
    throw new AppError("CONFLICT", { message: "This video is still processing. Try again when it finishes." });
  }
  if (video.status !== "ready" || !video.currentAnalysisRunId) throw new AppError("CONFLICT", { message: "This video has no clips to write for." });
  return video;
}

type LoadedVideo = Awaited<ReturnType<typeof loadVideo>>;

/** Back to the queue for the copy stage, if the plan allows another request. */
async function requeueCopy(ctx: Ctx, video: LoadedVideo, set: Record<string, unknown> = {}): Promise<void> {
  const limit = ctx.limits.copyRequestsPerVideo;
  if ((video.counts?.copyRequests ?? 0) >= limit) throw new AppError("COPY_REQUEST_LIMIT");
  if ((await countActiveJobs(ctx.user._id)) >= ctx.limits.concurrentJobs) throw new AppError("CONCURRENCY_LIMIT");
  const res = await Video.updateOne(
    {
      _id: video._id,
      ...ownedBy(ctx.user),
      deletedAt: null,
      status: "ready",
      "pipeline.runId": video.pipeline?.runId ?? null,
      "counts.copyRequests": { $not: { $gte: limit } },
    },
    {
      $set: {
        status: "queued",
        "pipeline.runId": newRunId(),
        "pipeline.recoveries": 0,
        "pipeline.stages.copy.status": "pending",
        "pipeline.stages.copy.progress": 0,
        ...set,
      },
      $unset: { error: 1, "pipeline.jobId": 1, "pipeline.heartbeatAt": 1, "pipeline.activity": 1 },
      $inc: { "counts.copyRequests": 1 },
    },
  );
  if (res.modifiedCount !== 1) throw new AppError("CONFLICT", { message: "This video just changed. Reload and try again." });
}

/** "Write again" (one clip), "Write post text" (every clip without it) or "Suggest words" (one clip's cover). */
export async function requestCopy(ctx: Ctx, videoId: string, input: z.input<typeof copyRequestSchema>): Promise<void> {
  const { clipId, part } = copyRequestSchema.parse(input);
  const mark = part === "cover" ? "coverRedoAt" : "copyRedoAt";
  const video = await loadVideo(ctx, videoId);
  if (!clipId) return requeueCopy(ctx, video);

  const clip = await Clip.findOne({ _id: clipId, videoId: video._id, ...ownedBy(ctx.user), deletedAt: null }).select({ analysisRunId: 1, keptAt: 1 }).lean();
  if (!clip || !isVisibleClip(video, clip)) throw new AppError("NOT_FOUND");
  // Marked first so the worker can't run before it knows which clip; undone if the video can't be queued.
  await Clip.updateOne({ _id: clip._id }, { $set: { [mark]: ctx.now ?? new Date() } });
  try {
    await requeueCopy(ctx, video);
  } catch (err) {
    await Clip.updateOne({ _id: clip._id }, { $unset: { [mark]: 1 } }).catch(() => {});
    throw err;
  }
}

/** The Banglish switch of a Bangla video: captions and post text in Bangla script or English letters. */
export async function setCaptionScript(ctx: Ctx, videoId: string, input: z.input<typeof captionScriptSchema>): Promise<void> {
  const { script } = captionScriptSchema.parse(input);
  const video = await loadVideo(ctx, videoId);
  if (video.language !== "bn") throw new AppError("VALIDATION_FAILED", { message: "Banglish is for Bangla videos." });
  if ((video.options?.captionScript ?? "Beng") === script) return;
  const retention = await getSettings("retention");
  if (video.retention?.assetsDeletedAt || isExpired(video, ctx.user.plan, retention, ctx.now)) throw new AppError("MEDIA_EXPIRED");
  await requeueCopy(ctx, video, { "options.captionScript": script });
}
