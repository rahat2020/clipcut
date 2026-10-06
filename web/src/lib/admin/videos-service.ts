/**
 * Admin: every user's videos — list, inspect, and the purpose-built actions from
 * docs/ADMIN.md (retry, cancel, re-pick clips with another model, delete). No
 * `server-only` and no env import, so scripts/admin-smoke-test.ts runs it for real.
 *
 * Every action: validate → act with a state-guarded update → audit log. Callers
 * (server actions) have already checked the admin role.
 */
import { Types } from "mongoose";
import { z } from "zod";

import {
  ACTIVE_VIDEO_STATUSES,
  AI_PROVIDERS,
  AnalysisRun,
  AppError,
  AuditLog,
  Clip,
  isClipSelectPromptVersion,
  LANGUAGES,
  newRunId,
  SOURCE_TYPES,
  STAGE_NAMES,
  Transcript,
  UsageEvent,
  User,
  Video,
  VIDEO_STATUSES,
  writeAudit,
  type AiProvider,
  type AuditActor,
} from "@/shared";

import type { CloudinaryConfig } from "../uploads/cloudinary-core";
import { deleteVideo } from "../videos/upload-service";

export const ADMIN_PAGE_SIZE = 50;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ── list ─────────────────────────────────────────────────────

export const videoListQuerySchema = z.object({
  status: z.enum(VIDEO_STATUSES).optional().catch(undefined),
  source: z.enum(SOURCE_TYPES).optional().catch(undefined),
  language: z.enum(LANGUAGES).optional().catch(undefined),
  /** Title words or an owner's email. */
  q: z.string().trim().max(200).optional().catch(undefined),
  user: z.string().regex(/^[a-f0-9]{24}$/).optional().catch(undefined),
  deleted: z.enum(["hide", "only", "all"]).catch("hide"),
  page: z.coerce.number().int().min(1).max(10_000).catch(1),
});
export type VideoListQuery = z.infer<typeof videoListQuerySchema>;

export type AdminVideoRow = {
  id: string;
  title: string;
  language: string;
  status: string;
  errorCode: string | null;
  errorStage: string | null;
  durationMs: number | null;
  sourceType: string;
  clips: number;
  createdAt: Date;
  deletedAt: Date | null;
  user: { id: string; email: string } | null;
};

export async function listVideosForAdmin(query: VideoListQuery): Promise<{ rows: AdminVideoRow[]; total: number }> {
  const filter: Record<string, unknown> = {};
  if (query.status) filter.status = query.status;
  if (query.source) filter["source.type"] = query.source;
  if (query.language) filter.language = query.language;
  if (query.user) filter.userId = new Types.ObjectId(query.user);
  if (query.deleted === "hide") filter.deletedAt = null;
  if (query.deleted === "only") filter.deletedAt = { $ne: null };
  if (query.q) {
    const rx = new RegExp(escapeRegex(query.q), "i");
    const owners = await User.find({ email: rx }).select({ _id: 1 }).limit(200).lean();
    filter.$or = [{ title: rx }, ...(owners.length ? [{ userId: { $in: owners.map((o) => o._id) } }] : [])];
  }

  const [docs, total] = await Promise.all([
    Video.find(filter)
      .select({ title: 1, language: 1, status: 1, error: 1, media: 1, "source.type": 1, counts: 1, createdAt: 1, deletedAt: 1, userId: 1 })
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * ADMIN_PAGE_SIZE)
      .limit(ADMIN_PAGE_SIZE)
      .lean(),
    Video.countDocuments(filter),
  ]);
  const users = await User.find({ _id: { $in: [...new Set(docs.map((d) => String(d.userId)))] } })
    .select({ email: 1 })
    .lean();
  const emailById = new Map(users.map((u) => [String(u._id), u.email]));

  return {
    total,
    rows: docs.map((d) => ({
      id: String(d._id),
      title: d.title,
      language: d.language,
      status: d.status,
      errorCode: d.error?.code ?? null,
      errorStage: d.error?.stage ?? null,
      durationMs: d.media?.durationMs ?? null,
      sourceType: d.source.type,
      clips: d.counts?.clips ?? 0,
      createdAt: d.createdAt,
      deletedAt: d.deletedAt ?? null,
      user: emailById.has(String(d.userId)) ? { id: String(d.userId), email: emailById.get(String(d.userId))! } : null,
    })),
  };
}

// ── one video ────────────────────────────────────────────────

/** Everything the admin video page shows. `runId` picks whose clips to list (default: current). */
export async function getVideoForAdmin(videoId: string, runId?: string | null) {
  if (!Types.ObjectId.isValid(videoId)) return null;
  const video = await Video.findById(videoId).lean();
  if (!video) return null;

  const selectedRunId =
    runId && Types.ObjectId.isValid(runId) ? new Types.ObjectId(runId) : (video.currentAnalysisRunId ?? null);
  const [owner, transcript, runs, clips, usage, audit] = await Promise.all([
    User.findById(video.userId).select({ email: 1, name: 1, plan: 1, status: 1 }).lean(),
    video.currentTranscriptId
      ? Transcript.findOne({ _id: video.currentTranscriptId, videoId: video._id })
          .select({ language: 1, provider: 1, model: 1, stats: 1, segments: 1, createdAt: 1 })
          .lean()
      : null,
    AnalysisRun.find({ videoId: video._id }).sort({ createdAt: -1 }).limit(30).lean(),
    selectedRunId
      ? Clip.find({ videoId: video._id, analysisRunId: selectedRunId }).sort({ rank: 1 }).lean()
      : Promise.resolve([]),
    UsageEvent.find({ videoId: video._id }).sort({ at: -1 }).limit(20).lean(),
    AuditLog.find({ "target.type": "video", "target.id": String(video._id) }).sort({ at: -1 }).limit(20).lean(),
  ]);
  return { video, owner, transcript, runs, clips, selectedRunId: selectedRunId ? String(selectedRunId) : null, usage, audit };
}

// ── actions ──────────────────────────────────────────────────

const objectId = z.string().regex(/^[a-f0-9]{24}$/, "not a valid id");

async function loadForAction(videoId: string) {
  const _id = new Types.ObjectId(objectId.parse(videoId));
  const video = await Video.findOne({ _id, deletedAt: null })
    .select({ status: 1, error: 1, pipeline: 1, retention: 1, currentTranscriptId: 1, currentAnalysisRunId: 1, userId: 1, title: 1 })
    .lean();
  if (!video) throw new AppError("NOT_FOUND", { message: "That video doesn't exist or was deleted." });
  return video;
}

/**
 * Back to `queued` under a new run id. Unlike the user's Retry, allowed for canceled
 * videos and for errors marked "retrying won't help" (the admin may have fixed the cause),
 * and skips the user's quota and one-at-a-time rules.
 */
export async function adminRetryVideo(actor: AuditActor, videoId: string): Promise<void> {
  const video = await loadForAction(videoId);
  if (video.status !== "failed" && video.status !== "canceled") {
    throw new AppError("CONFLICT", { message: "Only a failed or canceled video can be retried." });
  }
  if (video.retention?.assetsDeletedAt) throw new AppError("MEDIA_EXPIRED");

  const reset: Record<string, unknown> = {};
  for (const name of STAGE_NAMES) {
    const status = video.pipeline?.stages?.[name]?.status;
    if (status !== "done" && status !== "skipped") {
      reset[`pipeline.stages.${name}.status`] = "pending";
      reset[`pipeline.stages.${name}.progress`] = 0;
    }
  }
  const res = await Video.updateOne(
    { _id: video._id, status: video.status, deletedAt: null },
    {
      $set: { status: "queued", "pipeline.runId": newRunId(), "pipeline.recoveries": 0, "pipeline.quotaWaits": 0, ...reset },
      $unset: { error: 1, "retention.finishedAt": 1, "pipeline.jobId": 1, "pipeline.heartbeatAt": 1, "pipeline.activity": 1, "pipeline.waitUntil": 1 },
    },
  );
  if (res.modifiedCount !== 1) throw new AppError("CONFLICT");
  await writeAudit({
    actor,
    action: "video.retry",
    target: { type: "video", id: String(video._id) },
    diff: { before: { status: video.status, error: video.error?.code ?? null }, after: { status: "queued" } },
  });
}

/**
 * Stops a queued or processing video. The worker notices on its next guarded write (the
 * run's writes filter on status "processing") and stops without writing anything else.
 */
export async function adminCancelVideo(actor: AuditActor, videoId: string): Promise<void> {
  const video = await loadForAction(videoId);
  if (!(ACTIVE_VIDEO_STATUSES as readonly string[]).includes(video.status)) {
    throw new AppError("CONFLICT", { message: "Only a queued or processing video can be canceled." });
  }
  const res = await Video.updateOne(
    { _id: video._id, status: video.status, deletedAt: null },
    { $set: { status: "canceled", "retention.finishedAt": new Date() }, $unset: { "pipeline.activity": 1 } },
  );
  if (res.modifiedCount !== 1) throw new AppError("CONFLICT", { message: "The video's status just changed. Reload and try again." });
  await writeAudit({
    actor,
    action: "video.cancel",
    target: { type: "video", id: String(video._id) },
    diff: { before: { status: video.status }, after: { status: "canceled" } },
  });
}

export const rerunClipsSchema = z.object({
  provider: z.enum(AI_PROVIDERS),
  model: z.string().trim().min(1).max(100),
  promptVersion: z.string().refine(isClipSelectPromptVersion, "unknown prompt version"),
});
/** What the admin form sends; the prompt version is checked by rerunClipsSchema. */
export type RerunClipsInput = { provider: AiProvider; model: string; promptVersion: string };

/**
 * Picks the clips again with exactly this model and prompt (a new "regenerate" run; the
 * old runs and their clips stay for comparison). The video goes back to the queue from
 * "Finding moments"; the transcript is reused, so no minutes are charged.
 */
export async function adminRerunClipSelection(actor: AuditActor, videoId: string, input: RerunClipsInput): Promise<void> {
  const choice = rerunClipsSchema.parse(input);
  const video = await loadForAction(videoId);
  if ((ACTIVE_VIDEO_STATUSES as readonly string[]).includes(video.status)) {
    throw new AppError("CONFLICT", { message: "Wait until this video stops processing, then try again." });
  }
  if (!video.currentTranscriptId || video.pipeline?.stages?.transcribe?.status !== "done") {
    throw new AppError("CONFLICT", { message: "This video has no transcript yet, so clips can't be picked again." });
  }

  const reset: Record<string, unknown> = {};
  for (const name of ["analyze", "copy", "render"] as const) {
    reset[`pipeline.stages.${name}.status`] = "pending";
    reset[`pipeline.stages.${name}.progress`] = 0;
  }
  const res = await Video.updateOne(
    { _id: video._id, status: video.status, deletedAt: null },
    {
      $set: {
        status: "queued",
        "pipeline.runId": newRunId(),
        "pipeline.recoveries": 0,
        "pipeline.quotaWaits": 0,
        "pipeline.analyzeWith": { ...choice, requestedBy: actor.email, at: new Date() },
        ...reset,
      },
      $unset: { error: 1, "retention.finishedAt": 1, "pipeline.jobId": 1, "pipeline.heartbeatAt": 1, "pipeline.activity": 1, "pipeline.waitUntil": 1 },
    },
  );
  if (res.modifiedCount !== 1) throw new AppError("CONFLICT", { message: "The video's status just changed. Reload and try again." });
  await writeAudit({
    actor,
    action: "video.clips.rerun",
    target: { type: "video", id: String(video._id) },
    diff: {
      before: { status: video.status, currentAnalysisRunId: video.currentAnalysisRunId ? String(video.currentAnalysisRunId) : null },
      after: choice,
    },
  });
}

/** Deletes a video for its owner (same code path as the user's Delete), then audits. */
export async function adminDeleteVideo(ctx: { cfg: CloudinaryConfig; actor: AuditActor }, videoId: string): Promise<void> {
  const video = await loadForAction(videoId);
  await deleteVideo({ cfg: ctx.cfg, user: { _id: video.userId } }, String(video._id));
  await writeAudit({
    actor: ctx.actor,
    action: "video.delete",
    target: { type: "video", id: String(video._id) },
    diff: { before: { status: video.status, title: video.title, userId: String(video.userId) } },
  });
}
