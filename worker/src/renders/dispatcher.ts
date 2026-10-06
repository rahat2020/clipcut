import { logger } from "../lib/logger";
import { enqueueRender, type RenderQueue } from "../queues/render-queue";
import { AppError, getSettings, Render, RENDER_TIMING, renderJobId } from "../shared";

/**
 * MongoDB → BullMQ for renders, like the video dispatcher (D35): web/ only writes
 * `status: "queued"`; this loop queues them. A render whose worker went silent is queued
 * again, up to RENDER_TIMING.maxAttempts, then marked failed.
 */

const BATCH = 25;
const READD_AFTER_MS = 60_000;

export class RenderDispatcher {
  private readonly recentlyAdded = new Map<string, number>();

  constructor(private readonly queue: RenderQueue) {}

  async dispatchQueued(now = Date.now()): Promise<number> {
    const system = await getSettings("system");
    if (!system.processingEnabled) return 0;

    const queued = await Render.find({ status: "queued" })
      .sort({ "timings.queuedAt": 1 })
      .limit(BATCH)
      .select({ _id: 1, "timings.queuedAt": 1 })
      .lean();

    let enqueued = 0;
    for (const r of queued) {
      const renderId = String(r._id);
      const queuedAt = r.timings?.queuedAt;
      if (!queuedAt) {
        await Render.updateOne({ _id: r._id, status: "queued", "timings.queuedAt": null }, { $set: { "timings.queuedAt": new Date(now) } });
        continue;
      }
      const jobId = renderJobId(renderId, queuedAt.getTime());
      const addedAt = this.recentlyAdded.get(jobId);
      if (addedAt && now - addedAt < READD_AFTER_MS) continue;

      // A finished job for this exact queued instance means its claim missed (e.g. MongoDB
      // blipped). Adding it again is a no-op, so give the render a fresh instance instead.
      const existing = await this.queue.getJob(jobId);
      if (existing && ((await existing.isFailed()) || (await existing.isCompleted()))) {
        await Render.updateOne({ _id: r._id, status: "queued", "timings.queuedAt": queuedAt }, { $set: { "timings.queuedAt": new Date(now) } });
        continue;
      }

      await enqueueRender(this.queue, renderId, queuedAt.getTime());
      this.recentlyAdded.set(jobId, now);
      if (!addedAt) {
        enqueued++;
        logger.info({ renderId, jobId }, "render enqueued");
      }
    }
    for (const [jobId, at] of this.recentlyAdded) if (now - at > 10 * READD_AFTER_MS) this.recentlyAdded.delete(jobId);
    return enqueued;
  }

  async recoverStuck(now = new Date()): Promise<{ requeued: number; failed: number }> {
    const cutoff = new Date(now.getTime() - RENDER_TIMING.stuckAfterMs);
    const stuck = await Render.find({
      status: "rendering",
      $or: [{ "timings.heartbeatAt": { $lt: cutoff } }, { "timings.heartbeatAt": null, "timings.startedAt": { $lt: cutoff } }],
    })
      .limit(BATCH)
      .select({ _id: 1, attempts: 1, "timings.startedAt": 1 })
      .lean();

    let requeued = 0;
    let failed = 0;
    for (const r of stuck) {
      const guard = { _id: r._id, status: "rendering" as const, "timings.startedAt": r.timings?.startedAt ?? null };
      if ((r.attempts ?? 0) >= RENDER_TIMING.maxAttempts) {
        const err = new AppError("PROCESSING_STALLED");
        const res = await Render.updateOne(guard, { $set: { status: "failed", error: { code: err.code, message: err.message }, "timings.finishedAt": now } });
        if (res.modifiedCount === 1) failed++;
        continue;
      }
      const res = await Render.updateOne(guard, { $set: { status: "queued", progress: 0, "timings.queuedAt": now } });
      if (res.modifiedCount === 1) {
        requeued++;
        logger.warn({ renderId: String(r._id) }, "stuck render queued again");
      }
    }
    return { requeued, failed };
  }
}
