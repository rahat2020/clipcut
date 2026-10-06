import { Queue, type JobsOptions } from "bullmq";

import { bullConnection } from "../lib/redis";
import { PIPELINE_JOB_NAME, pipelineJobId, QUEUES, type PipelineJobData } from "../shared";

/**
 * Retries for errors that might pass on a second try (network, provider busy). Short
 * backoff: while a job waits between attempts its heartbeat is silent, and the
 * stuck-job sweep must not mistake that for a dead worker (PIPELINE_TIMING.stuckAfterMs).
 */
export const PIPELINE_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 10_000 },
  // MongoDB keeps the history; Redis only needs recent jobs for debugging.
  removeOnComplete: { age: 24 * 3600, count: 500 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export type PipelineQueue = Queue<PipelineJobData>;

/**
 * `prefix` isolates keys and `jobOptions` shortens backoff — both for the smoke test;
 * production uses the defaults.
 */
export function createPipelineQueue(options: { prefix?: string; jobOptions?: JobsOptions } = {}): PipelineQueue {
  return new Queue<PipelineJobData>(QUEUES.pipeline, {
    connection: bullConnection(),
    prefix: options.prefix,
    defaultJobOptions: { ...PIPELINE_JOB_OPTIONS, ...options.jobOptions },
  });
}

/** Adds the job for this run. Adding a run that is already in the queue does nothing. */
export async function enqueueRun(queue: PipelineQueue, videoId: string, runId: string): Promise<void> {
  await queue.add(PIPELINE_JOB_NAME, { v: 1, videoId, runId }, { jobId: pipelineJobId(videoId, runId) });
}
