import { Queue, type JobsOptions } from "bullmq";

import { bullConnection } from "../lib/redis";
import { QUEUES, RENDER_JOB_NAME, renderJobId, type RenderJobData } from "../shared";

/**
 * Renders the user asked for. No automatic retries: a failed render shows "Try again" to
 * the user, and a render whose worker died is queued again by the stuck sweep.
 */
export const RENDER_JOB_OPTIONS: JobsOptions = {
  attempts: 1,
  removeOnComplete: { age: 24 * 3600, count: 500 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export type RenderQueue = Queue<RenderJobData>;

export function createRenderQueue(options: { prefix?: string } = {}): RenderQueue {
  return new Queue<RenderJobData>(QUEUES.render, {
    connection: bullConnection(),
    prefix: options.prefix,
    defaultJobOptions: RENDER_JOB_OPTIONS,
  });
}

export async function enqueueRender(queue: RenderQueue, renderId: string, queuedAt: number): Promise<void> {
  await queue.add(RENDER_JOB_NAME, { v: 1, renderId, queuedAt }, { jobId: renderJobId(renderId, queuedAt) });
}
