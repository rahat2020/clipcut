import { Types } from "mongoose";

import {
  ACTIVE_VIDEO_STATUSES,
  AppError,
  getSettings,
  isExpired,
  newRunId,
  ownedBy,
  Video,
  type ClipIntent,
  type ClipRequestStatus,
  type PlanLimits,
} from "@/shared";

import { clipRequestSchema, type ClipRequestInput } from "./schemas";
import { countActiveJobs } from "./upload-service";

/**
 * "Find new clips" (Step 14, docs/DECISIONS.md D47): a finished video goes back to the queue
 * from "Finding moments" with a new focus or a description of what to find. The transcript is
 * reused, so no minutes are charged; each request is one AI call, capped per video by the
 * plan (`clipRequestsPerVideo`). The worker keeps approved clips and, if the request finds
 * nothing or fails, leaves the current clips as they were.
 * No `server-only`, no env import: scripts/review-smoke-test.ts runs it.
 */

type RequestUser = { _id: Types.ObjectId; plan: string };

/** What the video page shows about the latest request. */
export type ClipRequestView = {
  status: ClipRequestStatus;
  intent: ClipIntent;
  query: string | null;
  /** Why it failed, in words for the user (null unless failed). */
  failure: string | null;
  at: string;
};

export async function requestNewClips(
  ctx: { user: RequestUser; limits: PlanLimits; now?: Date },
  videoId: string,
  input: ClipRequestInput,
): Promise<void> {
  const now = ctx.now ?? new Date();
  const { intent, query } = clipRequestSchema.parse(input);
  const _id = new Types.ObjectId(videoId);
  const video = await Video.findOne({ _id, ...ownedBy(ctx.user), deletedAt: null })
    .select({ status: 1, pipeline: 1, currentTranscriptId: 1, retention: 1, counts: 1 })
    .lean();
  if (!video) throw new AppError("NOT_FOUND");
  if ((ACTIVE_VIDEO_STATUSES as readonly string[]).includes(video.status)) {
    throw new AppError("CONFLICT", { message: "This video is still processing. Try again when it finishes." });
  }
  if (video.status !== "ready" && video.status !== "failed") throw new AppError("CONFLICT");
  if (!video.currentTranscriptId || video.pipeline?.stages?.transcribe?.status !== "done") {
    throw new AppError("CONFLICT", { message: "This video has no transcript yet, so there's nothing to search." });
  }
  const [retention, ai] = await Promise.all([getSettings("retention"), getSettings("ai")]);
  if (video.retention?.assetsDeletedAt || isExpired(video, ctx.user.plan, retention, now)) throw new AppError("MEDIA_EXPIRED");
  if (!ai.clipSelection.enabled) {
    throw new AppError("AI_UNAVAILABLE", { message: "Finding clips is paused right now. Please try again later." });
  }

  const limit = ctx.limits.clipRequestsPerVideo;
  if ((video.counts?.clipRequests ?? 0) >= limit) throw new AppError("CLIP_REQUEST_LIMIT");
  if ((await countActiveJobs(ctx.user._id)) >= ctx.limits.concurrentJobs) throw new AppError("CONCURRENCY_LIMIT");

  const stages = video.pipeline?.stages;
  const reset: Record<string, unknown> = {};
  for (const name of ["analyze", "copy", "render"] as const) {
    reset[`pipeline.stages.${name}.status`] = "pending";
    reset[`pipeline.stages.${name}.progress`] = 0;
  }
  const res = await Video.updateOne(
    // Same status and run as read above, and still under the limit — a double click can't slip through.
    {
      _id,
      ...ownedBy(ctx.user),
      deletedAt: null,
      status: video.status,
      "pipeline.runId": video.pipeline?.runId ?? null,
      "counts.clipRequests": { $not: { $gte: limit } },
    },
    {
      $set: {
        status: "queued",
        "pipeline.runId": newRunId(),
        "pipeline.recoveries": 0,
        "options.intent": intent,
        ...(query ? { "options.customQuery": query } : {}),
        clipRequest: {
          status: "pending",
          intent,
          ...(query ? { query } : {}),
          requestedAt: now,
          previousStages: { analyze: stages?.analyze?.status, copy: stages?.copy?.status, render: stages?.render?.status },
        },
        ...reset,
      },
      $unset: {
        error: 1,
        "pipeline.jobId": 1,
        "pipeline.heartbeatAt": 1,
        "pipeline.activity": 1,
        ...(query ? {} : { "options.customQuery": 1 }),
      },
      $inc: { "counts.clipRequests": 1 },
    },
  );
  if (res.modifiedCount !== 1) throw new AppError("CONFLICT", { message: "This video just changed. Reload and try again." });
}

/** A result is mentioned on the page for a day; after that the page just shows the clips. */
const MENTION_FOR_MS = 24 * 3600_000;

/** The latest request, for the page — null when the user never asked or it's old news. */
export function toClipRequestView(video: {
  clipRequest?: { status: ClipRequestStatus; intent: ClipIntent; query?: string | null; errorCode?: string | null; requestedAt: Date } | null;
}): ClipRequestView | null {
  const r = video.clipRequest;
  if (!r || Date.now() - r.requestedAt.getTime() > MENTION_FOR_MS) return null;
  const failure =
    r.status !== "failed" ? null : r.errorCode === "AI_DAILY_CAP_REACHED" ? "today’s AI capacity is used up — try again tomorrow" : "the AI was busy — please try again in a few minutes";
  return { status: r.status, intent: r.intent, query: r.query ?? null, failure, at: r.requestedAt.toISOString() };
}
