import { Types } from "mongoose";

import {
  AppError,
  Clip,
  getSettings,
  isDuplicateKeyError,
  isExpired,
  isVisibleClip,
  ownedBy,
  Render,
  renderSpecForClip,
  renderSpecHash,
  specVideo,
  Transcript,
  Video,
  visibleClipsFilter,
  type RenderStatus,
  type VideoDoc,
} from "@/shared";

import { signedCoverFrameUrl, signedRenderUrl, type CloudinaryConfig } from "../uploads/cloudinary-core";

/**
 * Rendered clips, the web side (Step 12). The worker renders the best clips on its own;
 * the user asks for the rest here. web/ only writes `status: "queued"` — the worker's
 * render dispatcher does the rest (D35). No `server-only`, no env import: scripts/review-smoke-test.ts runs it.
 */

/** One clip's latest render, as the video page shows it (client-safe). */
export type RenderView = {
  id: string;
  clipId: string;
  status: RenderStatus;
  /** 0..1 */
  progress: number;
  error: string | null;
  /** Signed MP4 URL for the in-page 9:16 preview. */
  previewUrl: string | null;
  /** Our download route (records the "downloaded" signal, then redirects to the file). */
  downloadUrl: string | null;
  bytes: number | null;
  /** Clean 9:16 frames for the cover editor (Step 15.5); empty for older renders. */
  coverFrames: string[];
  /**
   * Made for different settings than the clip has now (older caption look, or later a new
   * trim / framing) — the page offers "Render again".
   */
  outdated: boolean;
};

type RenderUser = { _id: Types.ObjectId; plan: string };
type VideoForRenders = Pick<VideoDoc, "currentAnalysisRunId" | "currentTranscriptId" | "userId" | "retention" | "language" | "options"> & {
  _id: Types.ObjectId;
};

type RenderRow = {
  _id: Types.ObjectId;
  clipId: Types.ObjectId;
  status: RenderStatus;
  specHash: string;
  progress?: number | null;
  error?: { message?: string | null } | null;
  output?: { publicId?: string | null; bytes?: number | null } | null;
  assetDeletedAt?: Date | null;
  coverFrames?: string[] | null;
};

function toView(cfg: CloudinaryConfig, r: RenderRow, filesGone: boolean, currentHash: string | null): RenderView {
  const publicId = r.status === "ready" && !filesGone && !r.assetDeletedAt ? r.output?.publicId : null;
  return {
    id: String(r._id),
    clipId: String(r.clipId),
    status: r.status,
    progress: r.progress ?? 0,
    error: r.status === "failed" ? (r.error?.message ?? "Rendering failed.") : null,
    previewUrl: publicId ? signedRenderUrl(cfg, publicId) : null,
    downloadUrl: publicId ? `/api/renders/${String(r._id)}/download` : null,
    bytes: r.output?.bytes ?? null,
    coverFrames: publicId ? (r.coverFrames ?? []).map((id) => signedCoverFrameUrl(cfg, id)) : [],
    outdated: currentHash !== null && r.specHash !== currentHash,
  };
}

const ROW_FIELDS = { clipId: 1, status: 1, specHash: 1, progress: 1, error: 1, output: 1, assetDeletedAt: 1, coverFrames: 1 } as const;

/** The latest render of every clip the video shows (current set + kept clips). */
export async function loadRenderViews(cfg: CloudinaryConfig, video: VideoForRenders): Promise<RenderView[]> {
  if (!video.currentAnalysisRunId) return [];
  const clips = await Clip.find({ ...visibleClipsFilter(video), userId: video.userId, latestRenderId: { $ne: null } })
    .select({ latestRenderId: 1, startMs: 1, endMs: 1, edit: 1, "copy.emphasis": 1 })
    .lean();
  const ids = clips.map((c) => c.latestRenderId).filter((id): id is Types.ObjectId => !!id);
  if (ids.length === 0) return [];
  const [renders, transcript] = await Promise.all([
    Render.find({ _id: { $in: ids }, videoId: video._id, userId: video.userId }).select(ROW_FIELDS).lean<RenderRow[]>(),
    Transcript.findOne({ _id: video.currentTranscriptId, videoId: video._id }).select({ version: 1 }).lean(),
  ]);
  // What each clip would render as today; a render with another hash is out of date.
  const currentHash = new Map(
    clips.map((c) => [
      String(c._id),
      transcript ? renderSpecHash(renderSpecForClip(c, specVideo(video), transcript.version)) : null,
    ]),
  );
  const filesGone = !!video.retention?.assetsDeletedAt;
  return renders.map((r) => toView(cfg, r, filesGone, currentHash.get(String(r.clipId)) ?? null));
}

/** `GET /api/videos/:id/renders` — the video must be the user's. */
export async function loadRenderViewsForUser(cfg: CloudinaryConfig, user: RenderUser, videoId: string): Promise<RenderView[]> {
  const video = await Video.findOne({ _id: videoId, ...ownedBy(user), deletedAt: null })
    .select({ currentAnalysisRunId: 1, currentTranscriptId: 1, userId: 1, retention: 1, language: 1, options: 1 })
    .lean<VideoForRenders>();
  if (!video) throw new AppError("NOT_FOUND");
  return loadRenderViews(cfg, video);
}

/**
 * User presses "Render clip": queue a render of the clip as it stands, or return the one
 * that already exists for exactly that spec. A failed one is queued again.
 */
export async function requestRender(ctx: { cfg: CloudinaryConfig; user: RenderUser; now?: Date }, clipId: string): Promise<RenderView> {
  const now = ctx.now ?? new Date();
  const clip = await Clip.findOne({ _id: clipId, ...ownedBy(ctx.user), deletedAt: null })
    .select({ videoId: 1, analysisRunId: 1, keptAt: 1, startMs: 1, endMs: 1, edit: 1, "copy.emphasis": 1 })
    .lean();
  if (!clip) throw new AppError("NOT_FOUND");
  const video = await Video.findOne({ _id: clip.videoId, ...ownedBy(ctx.user), deletedAt: null })
    .select({ status: 1, language: 1, options: 1, currentTranscriptId: 1, currentAnalysisRunId: 1, retention: 1, userId: 1 })
    .lean();
  if (!video || !isVisibleClip(video, clip)) throw new AppError("NOT_FOUND");
  if (video.status === "queued" || video.status === "processing") {
    throw new AppError("CONFLICT", { message: "This video is still processing. Try again when it finishes." });
  }
  const retention = await getSettings("retention");
  if (video.retention?.assetsDeletedAt || isExpired(video, ctx.user.plan, retention, now)) throw new AppError("MEDIA_EXPIRED");

  const transcript = await Transcript.findOne({ _id: video.currentTranscriptId, videoId: video._id }).select({ version: 1 }).lean();
  if (!transcript) throw new AppError("NOT_FOUND", { message: "This video has no transcript." });

  const spec = renderSpecForClip(clip, specVideo(video), transcript.version);
  const specHash = renderSpecHash(spec);
  const insert = {
    clipId: clip._id,
    videoId: video._id,
    userId: video.userId,
    spec,
    specHash,
    status: "queued",
    progress: 0,
    attempts: 0,
    timings: { queuedAt: now },
  };
  let render: RenderRow | null;
  try {
    render = await Render.findOneAndUpdate({ clipId: clip._id, specHash }, { $setOnInsert: insert }, { upsert: true, returnDocument: "after", projection: ROW_FIELDS }).lean<RenderRow>();
  } catch (err) {
    // Two clicks raced on the unique index; the other one created it.
    if (!isDuplicateKeyError(err)) throw err;
    render = await Render.findOne({ clipId: clip._id, specHash }).select(ROW_FIELDS).lean<RenderRow>();
  }
  if (!render) throw new AppError("INTERNAL");

  if (render.status === "failed" || (render.status === "ready" && render.assetDeletedAt)) {
    // (An out-of-date render has a different spec hash, so it never lands here — a new render is made instead.)
    render =
      (await Render.findOneAndUpdate(
        { _id: render._id, status: render.status },
        { $set: { status: "queued", progress: 0, "timings.queuedAt": now }, $unset: { error: 1, "timings.finishedAt": 1, assetDeletedAt: 1, output: 1 } },
        { returnDocument: "after", projection: ROW_FIELDS },
      ).lean<RenderRow>()) ?? render;
  }
  await Clip.updateOne({ _id: clip._id, ...ownedBy(ctx.user) }, { $set: { latestRenderId: render._id } });
  return toView(ctx.cfg, render, false, specHash);
}

/**
 * The Download button: records the "downloaded" signal on the clip (Admin → Accuracy) and
 * returns a signed URL that downloads the MP4 as "clip-3.mp4".
 */
export async function downloadRender(ctx: { cfg: CloudinaryConfig; user: RenderUser }, renderId: string): Promise<string> {
  const render = await Render.findOne({ _id: renderId, ...ownedBy(ctx.user), status: "ready", assetDeletedAt: null })
    .select({ clipId: 1, videoId: 1, output: 1 })
    .lean();
  const publicId = render?.output?.publicId;
  if (!render || !publicId) throw new AppError("NOT_FOUND");
  const video = await Video.findOne({ _id: render.videoId, ...ownedBy(ctx.user), deletedAt: null }).select({ retention: 1 }).lean();
  if (!video) throw new AppError("NOT_FOUND");
  if (video.retention?.assetsDeletedAt) throw new AppError("MEDIA_EXPIRED");

  const clip = await Clip.findOneAndUpdate(
    { _id: render.clipId, ...ownedBy(ctx.user) },
    { $set: { "signals.downloaded": true } },
    { projection: { rank: 1 } },
  ).lean();
  return signedRenderUrl(ctx.cfg, publicId, `clip-${clip?.rank ?? 1}`);
}
