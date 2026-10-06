import { logger } from "../lib/logger";
import { enqueueRun, type PipelineQueue } from "../queues/pipeline-queue";
import {
  AppError,
  getSettings,
  newRunId,
  PIPELINE_TIMING,
  pipelineJobId,
  Video,
  type StageName,
} from "../shared";

/**
 * MongoDB → BullMQ. web/ only writes `status: "queued"`; this loop gives each queued
 * video a run id and puts it in the queue (docs/DECISIONS.md D35). Because it reads
 * MongoDB every time, a Redis restart that wipes the queue loses nothing.
 *
 * It also finds `processing` videos whose worker went silent (crash, deploy, lost
 * Redis job) and restarts them under a new run id, up to PIPELINE_TIMING.maxRecoveries.
 */

const BATCH = 25;
/** Don't re-add the same run more often than this (adding is a no-op, but costs a call). */
const READD_AFTER_MS = 60_000;

export type DispatchResult = { enqueued: number; skippedPaused: boolean };
export type RecoverResult = { restarted: number; failed: number };

export class Dispatcher {
  private readonly recentlyAdded = new Map<string, number>();

  constructor(private readonly queue: PipelineQueue) {}

  /** One pass over queued videos, oldest first. */
  async dispatchQueued(now = Date.now()): Promise<DispatchResult> {
    const system = await getSettings("system");
    if (!system.processingEnabled) return { enqueued: 0, skippedPaused: true };

    // A video waiting for the AI's quota (`pipeline.waitUntil`) is left alone until its time.
    const queued = await Video.find({
      status: "queued",
      deletedAt: null,
      $or: [{ "pipeline.waitUntil": null }, { "pipeline.waitUntil": { $lte: new Date(now) } }],
    })
      .sort({ createdAt: 1 })
      .limit(BATCH)
      .select({ _id: 1, "pipeline.runId": 1 })
      .lean();

    let enqueued = 0;
    for (const v of queued) {
      const videoId = String(v._id);
      let runId = v.pipeline?.runId;
      if (!runId) {
        // Videos created by web/ have no run yet. Assign one — guarded, so two
        // dispatchers can't give the same video two different runs.
        const fresh = newRunId();
        const res = await Video.updateOne(
          { _id: v._id, status: "queued", "pipeline.runId": null },
          { $set: { "pipeline.runId": fresh } },
        );
        if (res.modifiedCount !== 1) continue; // someone else did; next pass picks it up
        runId = fresh;
      }

      const jobId = pipelineJobId(videoId, runId);
      const addedAt = this.recentlyAdded.get(jobId);
      if (addedAt && now - addedAt < READD_AFTER_MS) continue;

      // A finished job with this id means the run died before it could claim the video
      // (e.g. MongoDB was unreachable). Adding again would be a no-op, so start a new run.
      const existing = await this.queue.getJob(jobId);
      if (existing && ((await existing.isFailed()) || (await existing.isCompleted()))) {
        await Video.updateOne(
          { _id: v._id, status: "queued", "pipeline.runId": runId },
          { $set: { "pipeline.runId": newRunId() }, $inc: { "pipeline.recoveries": 1 } },
        );
        continue;
      }

      await enqueueRun(this.queue, videoId, runId);
      this.recentlyAdded.set(jobId, now);
      if (!addedAt) {
        enqueued++;
        logger.info({ videoId, jobId }, "video enqueued");
      }
    }

    for (const [jobId, at] of this.recentlyAdded) if (now - at > 10 * READD_AFTER_MS) this.recentlyAdded.delete(jobId);
    return { enqueued, skippedPaused: false };
  }

  /** Restarts (or, after too many restarts, fails) runs whose heartbeat went quiet. */
  async recoverStuck(now = new Date()): Promise<RecoverResult> {
    const cutoff = new Date(now.getTime() - PIPELINE_TIMING.stuckAfterMs);
    const stuck = await Video.find({
      status: "processing",
      deletedAt: null,
      $or: [{ "pipeline.heartbeatAt": { $lt: cutoff } }, { "pipeline.heartbeatAt": null, updatedAt: { $lt: cutoff } }],
    })
      .limit(BATCH)
      .select({ _id: 1, pipeline: 1 })
      .lean();

    let restarted = 0;
    let failed = 0;
    for (const v of stuck) {
      const oldRunId = v.pipeline?.runId ?? null;
      const stage = (v.pipeline?.stage ?? null) as StageName | null;
      const guard = { _id: v._id, status: "processing" as const, "pipeline.runId": oldRunId };

      if ((v.pipeline?.recoveries ?? 0) >= PIPELINE_TIMING.maxRecoveries) {
        const err = new AppError("PROCESSING_STALLED");
        const res = await Video.updateOne(guard, {
          $set: {
            status: "failed",
            error: { code: err.code, message: err.message, ...(stage ? { stage } : {}), retryable: true, at: now },
            ...(stage ? { [`pipeline.stages.${stage}.status`]: "failed" } : {}),
          },
          $min: { "retention.finishedAt": now },
        });
        if (res.modifiedCount === 1) {
          failed++;
          logger.warn({ videoId: String(v._id), stage }, "stuck run failed after too many restarts");
        }
        continue;
      }

      // Back to the queue under a new run id; the old run's worker (if it ever wakes
      // up) can no longer write. Finished stages stay finished.
      const res = await Video.updateOne(guard, {
        $set: {
          status: "queued",
          "pipeline.runId": newRunId(),
          ...(stage ? { [`pipeline.stages.${stage}.status`]: "pending" } : {}),
        },
        $unset: { "pipeline.jobId": 1 },
        $inc: { "pipeline.recoveries": 1 },
      });
      if (res.modifiedCount === 1) {
        restarted++;
        logger.warn({ videoId: String(v._id), stage }, "stuck run restarted");
      }
    }
    return { restarted, failed };
  }
}
