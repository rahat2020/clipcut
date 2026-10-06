import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

import { Worker } from "bullmq";

import { env } from "./config/env";
import { connectDb } from "./lib/db";
import { logger } from "./lib/logger";
import { every } from "./lib/loop";
import { clearPresence, publishPresence, WORKER_ID } from "./lib/presence";
import { bullConnection } from "./lib/redis";
import { onShutdown, runShutdownHooks } from "./lib/shutdown";
import { scheduledCleanup } from "./cleanup/schedule";
import { Dispatcher } from "./pipeline/dispatcher";
import { processPipelineJob } from "./processors/pipeline-processor";
import { processRenderJob } from "./processors/render-processor";
import { createPipelineQueue } from "./queues/pipeline-queue";
import { createRenderQueue } from "./queues/render-queue";
import { RenderDispatcher } from "./renders/dispatcher";
import {
  CLEANUP_TIMING,
  getSettings,
  getSettingsSnapshot,
  PIPELINE_TIMING,
  QUEUES,
  RENDER_TIMING,
  WORKER_PRESENCE,
  type PipelineJobData,
  type RenderJobData,
} from "./shared";

/**
 * Worker entry point: connects to MongoDB and Redis, then runs side by side:
 *   1. the BullMQ worker that processes videos (src/processors/pipeline-processor.ts),
 *   2. the dispatcher that moves `queued` videos from MongoDB into the queue, and
 *      restarts stuck runs (src/pipeline/dispatcher.ts),
 *   3. the render worker + its dispatcher: clips the user asks to render (Step 12,
 *      src/processors/render-processor.ts, src/renders/dispatcher.ts), one at a time,
 *   4. a presence heartbeat in Redis for the admin panel.
 * SIGINT/SIGTERM: stop taking work, let the current job finish, then close connections.
 */

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down — finishing the current job first");
  await runShutdownHooks((err) => logger.error({ err }, "shutdown hook failed"));
  logger.info("bye");
  process.exit(0);
}

/** Per-job folders live here (never the scratch root: tests and fixtures share it). */
const JOBS_DIR = path.join(env.SCRATCH_DIR, "jobs");

/** Job folders left by a crash. Only this worker uses this folder, so all are stale. */
async function clearStaleJobFolders(): Promise<void> {
  const entries = await readdir(JOBS_DIR, { withFileTypes: true });
  await Promise.all(
    entries.filter((e) => e.isDirectory()).map((e) => rm(path.join(JOBS_DIR, e.name), { recursive: true, force: true })),
  );
}

async function main(): Promise<void> {
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await mkdir(JOBS_DIR, { recursive: true });
  await clearStaleJobFolders();

  const conn = await connectDb();
  logger.info({ host: conn.connection.host, db: conn.connection.name }, "connected to MongoDB");

  const ai = await getSettingsSnapshot("ai");
  if (ai.invalid) logger.warn("stored AI settings don't match the schema — running on defaults");
  const system = await getSettings("system");
  const concurrency = system.workerConcurrency;

  const queue = createPipelineQueue();
  onShutdown(() => queue.close());

  const worker = new Worker<PipelineJobData>(
    QUEUES.pipeline,
    (job) => processPipelineJob(job, { scratchRoot: JOBS_DIR }),
    { connection: bullConnection(), concurrency },
  );
  worker.on("error", (err) => logger.error({ err }, "queue worker error"));
  let inFlight = 0;
  worker.on("active", () => void inFlight++);
  worker.on("completed", () => void inFlight--);
  worker.on("failed", () => void inFlight--);
  onShutdown(() => worker.close());
  await worker.waitUntilReady();

  // Renders: one at a time — encoding already uses every core.
  const renderQueue = createRenderQueue();
  onShutdown(() => renderQueue.close());
  const renderWorker = new Worker<RenderJobData>(QUEUES.render, (job) => processRenderJob(job, { scratchRoot: JOBS_DIR }), {
    connection: bullConnection(),
    concurrency: 1,
  });
  renderWorker.on("error", (err) => logger.error({ err }, "render worker error"));
  onShutdown(() => renderWorker.close());
  await renderWorker.waitUntilReady();
  const renderDispatcher = new RenderDispatcher(renderQueue);
  const stopRenderDispatch = every("dispatch-renders", RENDER_TIMING.dispatchEveryMs, async () => {
    await renderDispatcher.dispatchQueued();
  });
  const stopRenderRecover = every("recover-renders", RENDER_TIMING.recoverEveryMs, async () => {
    const r = await renderDispatcher.recoverStuck();
    if (r.requeued || r.failed) logger.info(r, "stuck renders handled");
  });

  const dispatcher = new Dispatcher(queue);
  const stopRecover = every("recover-stuck", PIPELINE_TIMING.recoverEveryMs, async () => {
    const r = await dispatcher.recoverStuck();
    if (r.restarted || r.failed) logger.info(r, "stuck runs handled");
  });
  const stopDispatch = every("dispatch", PIPELINE_TIMING.dispatchEveryMs, async () => {
    await dispatcher.dispatchQueued();
  });
  // Expired / deleted / abandoned files (Step 17, D51): every 30 min; the scan for files nobody owns once a day.
  const stopCleanup = every("cleanup", CLEANUP_TIMING.everyMs, async () => {
    await scheduledCleanup({ orphans: false });
  });
  const stopOrphanScan = every("cleanup-orphans", CLEANUP_TIMING.orphanScanEveryMs, async () => {
    await scheduledCleanup({ orphans: true });
  });
  const stopPresence = every("presence", WORKER_PRESENCE.intervalMs, async () => {
    await publishPresence(queue, { concurrency, activeJobs: Math.max(inFlight, 0) });
  });
  // Registered last → runs first: stop feeding the queue before the worker closes.
  onShutdown(async () => {
    await Promise.all([stopDispatch(), stopRecover(), stopPresence(), stopRenderDispatch(), stopRenderRecover(), stopCleanup(), stopOrphanScan()]);
    await clearPresence().catch(() => {});
  });

  logger.info(
    {
      workerId: WORKER_ID,
      concurrency,
      processingEnabled: system.processingEnabled,
      transcription: ai.value.transcription.model,
      clipSelection: ai.value.clipSelection.model,
      scratchDir: JOBS_DIR,
      cloudinaryFolder: env.CLOUDINARY_FOLDER,
    },
    "worker ready — waiting for videos",
  );
  if (!system.processingEnabled) logger.warn("processing is switched off in settings — queued videos will wait");
}

main().catch((err: unknown) => {
  logger.fatal({ err }, "worker failed to start");
  process.exit(1);
});
