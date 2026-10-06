import type { Types } from "mongoose";

import { ToolError } from "../lib/exec";
import { logger } from "../lib/logger";
import {
  AppError,
  Clip,
  isDuplicateKeyError,
  Render,
  RENDER_TIMING,
  renderSpecHash,
  type RenderSpec,
} from "../shared";

/**
 * Render documents, the worker side (docs/SCHEMA.md §3.6). A render is worked on by whoever
 * CLAIMS it (`queued`/`failed` → `rendering`, stamped with `timings.startedAt`); every later
 * write is filtered on that stamp, so a render taken over by the stuck sweep can't be
 * overwritten by the worker that went silent (same idea as the pipeline's run id).
 */

/** This render was taken away (restarted by the stuck sweep, or deleted). Stop without writing. */
export class RenderLostError extends Error {
  constructor(readonly renderId: string) {
    super(`render ${renderId} is no longer ours`);
    this.name = "RenderLostError";
  }
}

export type RenderOutput = { publicId: string; secureUrl: string; bytes: number; durationMs: number | null };

const PROGRESS_WRITE_MS = 3_000;

export class RenderHandle {
  readonly id: string;
  private timer: NodeJS.Timeout | null = null;
  private lastWriteAt = 0;

  constructor(
    readonly _id: Types.ObjectId,
    private readonly startedAt: Date,
  ) {
    this.id = String(_id);
  }

  private async write(update: Record<string, unknown>): Promise<void> {
    const res = await Render.updateOne({ _id: this._id, status: "rendering", "timings.startedAt": this.startedAt }, update);
    if (res.matchedCount !== 1) throw new RenderLostError(this.id);
  }

  /** Keeps `timings.heartbeatAt` fresh while downloads and uploads run (they report no progress). */
  startHeartbeat(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.write({ $set: { "timings.heartbeatAt": new Date() } }).catch((err: unknown) => {
        if (!(err instanceof RenderLostError)) logger.warn({ err, renderId: this.id }, "render heartbeat failed");
      });
    }, RENDER_TIMING.heartbeatMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 0..1, throttled. Never throws — a lost render is noticed by the next real write. */
  progress(fraction: number): void {
    const now = Date.now();
    if (now - this.lastWriteAt < PROGRESS_WRITE_MS) return;
    this.lastWriteAt = now;
    this.write({ $set: { progress: Math.round(Math.min(Math.max(fraction, 0), 1) * 100) / 100, "timings.heartbeatAt": new Date() } }).catch(
      () => {},
    );
  }

  async finish(output: RenderOutput, encodeMs: number, coverFrames: string[] = []): Promise<void> {
    await this.write({
      $set: {
        status: "ready",
        coverFrames,
        progress: 1,
        output: { publicId: output.publicId, secureUrl: output.secureUrl, bytes: output.bytes, ...(output.durationMs != null ? { durationMs: output.durationMs } : {}) },
        "timings.finishedAt": new Date(),
        "timings.encodeMs": encodeMs,
      },
      $unset: { error: 1 },
    });
  }

  async fail(err: AppError): Promise<void> {
    const detail = technicalDetail(err);
    await this.write({
      $set: { status: "failed", error: { code: err.code, message: err.message, ...(detail ? { detail } : {}) }, "timings.finishedAt": new Date() },
    });
  }
}

/** The end of a tool's stderr (yt-dlp, ffmpeg) behind an AppError, for the render row. */
function technicalDetail(err: AppError): string | null {
  const cause = err.cause;
  if (cause instanceof ToolError) return `${cause.tool} ${cause.reason}: ${cause.stderrTail}`.slice(-1000);
  if (cause instanceof Error) return cause.message.slice(-1000);
  return null;
}

const claimSet = (now: Date) => ({
  $set: { status: "rendering", progress: 0, "timings.startedAt": now, "timings.heartbeatAt": now },
  $unset: { error: 1, "timings.finishedAt": 1 },
  $inc: { attempts: 1 },
});

/** The render queue's claim: only the exact queued instance the job was made for. */
export async function claimQueuedRender(renderId: string, queuedAt: Date, now = new Date()): Promise<RenderHandle | null> {
  const doc = await Render.findOneAndUpdate({ _id: renderId, status: "queued", "timings.queuedAt": queuedAt }, claimSet(now), {
    returnDocument: "after",
    projection: { _id: 1 },
  }).lean();
  return doc ? new RenderHandle(doc._id, now) : null;
}

export type PipelineClaim =
  | { kind: "claimed"; handle: RenderHandle }
  /** Already rendered with this exact spec. */
  | { kind: "ready"; renderId: string }
  /** Someone else is rendering it right now (the render queue); leave it to them. */
  | { kind: "busy"; renderId: string };

/**
 * The pipeline's auto-render: create the render already claimed (so the render queue never
 * picks it up), or take over a queued/failed one with the same spec.
 */
export async function claimRenderForPipeline(args: {
  clipId: Types.ObjectId;
  videoId: Types.ObjectId;
  userId: Types.ObjectId;
  spec: RenderSpec;
  now?: Date;
}): Promise<PipelineClaim> {
  const now = args.now ?? new Date();
  const specHash = renderSpecHash(args.spec);
  let claim: PipelineClaim;
  try {
    const created = await Render.create({
      clipId: args.clipId,
      videoId: args.videoId,
      userId: args.userId,
      spec: args.spec,
      specHash,
      status: "rendering",
      attempts: 1,
      timings: { queuedAt: now, startedAt: now, heartbeatAt: now },
    });
    claim = { kind: "claimed", handle: new RenderHandle(created._id, now) };
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const taken = await Render.findOneAndUpdate({ clipId: args.clipId, specHash, status: { $in: ["queued", "failed"] } }, claimSet(now), {
      returnDocument: "after",
      projection: { _id: 1 },
    }).lean();
    if (taken) {
      claim = { kind: "claimed", handle: new RenderHandle(taken._id, now) };
    } else {
      const existing = await Render.findOne({ clipId: args.clipId, specHash }).select({ status: 1 }).lean();
      if (!existing) throw new AppError("CONFLICT", { message: "The render disappeared while claiming it." });
      claim = { kind: existing.status === "ready" ? "ready" : "busy", renderId: String(existing._id) };
    }
  }
  const renderId = claim.kind === "claimed" ? claim.handle._id : claim.renderId;
  await Clip.updateOne({ _id: args.clipId }, { $set: { latestRenderId: renderId } });
  return claim;
}

/**
 * A later pipeline run (new clips, a retry) has no source on disk: instead of downloading the
 * whole video, queue the render — the render queue fetches only the clip's part. An existing
 * render with the same spec is left as it is.
 */
export async function queueRenderForPipeline(args: {
  clipId: Types.ObjectId;
  videoId: Types.ObjectId;
  userId: Types.ObjectId;
  spec: RenderSpec;
  now?: Date;
}): Promise<string> {
  const now = args.now ?? new Date();
  const specHash = renderSpecHash(args.spec);
  const insert = {
    clipId: args.clipId,
    videoId: args.videoId,
    userId: args.userId,
    spec: args.spec,
    specHash,
    status: "queued",
    progress: 0,
    attempts: 0,
    timings: { queuedAt: now },
  };
  let doc: { _id: Types.ObjectId } | null;
  try {
    doc = await Render.findOneAndUpdate({ clipId: args.clipId, specHash }, { $setOnInsert: insert }, { upsert: true, returnDocument: "after", projection: { _id: 1 } }).lean();
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    doc = await Render.findOne({ clipId: args.clipId, specHash }).select({ _id: 1 }).lean();
  }
  if (!doc) throw new AppError("INTERNAL", { message: "The render disappeared while queueing it." });
  await Clip.updateOne({ _id: args.clipId }, { $set: { latestRenderId: doc._id } });
  return String(doc._id);
}
