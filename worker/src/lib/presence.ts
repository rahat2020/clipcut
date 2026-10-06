import { hostname } from "node:os";

import type { PipelineQueue } from "../queues/pipeline-queue";
import { WORKER_PRESENCE, type WorkerPresence } from "../shared";
import { redis } from "./redis";

export const WORKER_ID = `${hostname()}-${process.pid}`;
const startedAt = new Date().toISOString();

/**
 * Writes `worker:<id>:heartbeat` (expires on its own) so the admin panel can show which
 * workers are alive and the queue's size, without web/ reading BullMQ's internal keys.
 */
export async function publishPresence(queue: PipelineQueue, info: { concurrency: number; activeJobs: number }) {
  const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed");
  const value: WorkerPresence = {
    id: WORKER_ID,
    startedAt,
    at: new Date().toISOString(),
    concurrency: info.concurrency,
    activeJobs: info.activeJobs,
    queue: {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      failed: counts.failed ?? 0,
    },
  };
  await redis().set(WORKER_PRESENCE.key(WORKER_ID), JSON.stringify(value), "EX", WORKER_PRESENCE.ttlSeconds);
}

export async function clearPresence(): Promise<void> {
  await redis().del(WORKER_PRESENCE.key(WORKER_ID));
}
