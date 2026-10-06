import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { UnrecoverableError, type Job } from "bullmq";

import { logger } from "../lib/logger";
import { claimRun, PipelineRun, RunLostError } from "../pipeline/run";
import { STAGE_HANDLERS } from "../pipeline/stages";
import type { StageHandler } from "../pipeline/stages/types";
import { AppError, isAppError, PIPELINE_TIMING, STAGE_NAMES, type ErrorCode, type PipelineJobData, type StageName } from "../shared";

/** How a job ended without throwing. A failed run throws UnrecoverableError instead. */
export type PipelineOutcome =
  | { outcome: "ready" }
  | { outcome: "skipped"; reason: string }
  | { outcome: "abandoned" }
  | { outcome: "waiting"; until: Date };

export type ProcessorDeps = {
  scratchRoot: string;
  handlers?: Partial<Record<StageName, StageHandler>>;
};

/** Errors that are "try again later" for the user but pointless to retry right now. */
const NO_AUTO_RETRY = new Set<ErrorCode>(["STAGE_NOT_READY", "PROCESSING_STALLED", "AI_DAILY_CAP_REACHED"]);

function parseJobData(data: unknown): PipelineJobData {
  const d = data as Partial<PipelineJobData> | null;
  if (d?.v !== 1 || typeof d.videoId !== "string" || !/^[a-f0-9]{24}$/.test(d.videoId) || typeof d.runId !== "string") {
    throw new UnrecoverableError("unknown pipeline job payload");
  }
  return { v: 1, videoId: d.videoId, runId: d.runId };
}

/** `details.resumeAt` from the AI layer; an hour from now when it isn't there. */
function waitUntilFor(err: AppError, now = Date.now()): Date {
  const at = new Date(String(err.details?.resumeAt ?? ""));
  return Number.isNaN(at.getTime()) || at.getTime() <= now ? new Date(now + 60 * 60_000) : at;
}

function toAppError(err: unknown): AppError {
  if (isAppError(err)) return err;
  return new AppError("INTERNAL", { cause: err });
}

/**
 * Runs one video through every stage that isn't finished yet. MongoDB decides what's
 * left to do, so a retried or resumed job continues where the last one stopped.
 *
 * Retry policy: a retryable error on a non-final attempt is rethrown so BullMQ tries
 * again (the video stays `processing`). Anything else ends the run as `failed` with a
 * user-safe error, and the job is marked unrecoverable.
 */
export async function processPipelineJob(job: Job<PipelineJobData>, deps: ProcessorDeps): Promise<PipelineOutcome> {
  const { videoId, runId } = parseJobData(job.data);
  const jobId = job.id ?? `${videoId}-${runId}`;
  const log = logger.child({ videoId, jobId, attempt: job.attemptsMade + 1 });
  const handlers = deps.handlers ?? STAGE_HANDLERS;

  const claim = await claimRun(videoId, runId, jobId);
  if (claim.kind === "skip") {
    log.info({ reason: claim.reason }, "job skipped");
    return { outcome: "skipped", reason: claim.reason };
  }
  log.info({ claim: claim.kind }, claim.kind === "started" ? "run started" : "run resumed");

  const run = new PipelineRun(claim.video, runId);
  // Kept when BullMQ will retry this job, so the next attempt reuses the downloaded source.
  let keepScratch = false;
  const scratchDir = path.join(deps.scratchRoot, jobId);
  run.startHeartbeat();

  try {
    await mkdir(scratchDir, { recursive: true });
    for (const stage of STAGE_NAMES) {
      const status = run.stageStatus(stage);
      if (status === "done" || status === "skipped") continue;

      const handler = handlers[stage];
      if (!handler) throw Object.assign(new AppError("STAGE_NOT_READY"), { stage });

      await run.startStage(stage);
      const t0 = Date.now();
      const result = await handler({ video: claim.video, run, scratchDir, log: log.child({ stage }) });
      await run.finishStage(stage, result === "skipped" ? "skipped" : "done");
      log.info({ stage, ms: Date.now() - t0, result: result ?? "done" }, "stage finished");
    }
    await run.markReady();
    log.info("run ready");
    return { outcome: "ready" };
  } catch (err) {
    if (err instanceof RunLostError) {
      log.info("run lost (deleted, canceled or restarted) — stopped without writing");
      return { outcome: "abandoned" };
    }
    const appErr = toAppError(err);
    const stage = (err as { stage?: StageName }).stage ?? run.current;
    const attempts = job.opts.attempts ?? 1;
    const willRetry = appErr.retryable && !NO_AUTO_RETRY.has(appErr.code) && job.attemptsMade + 1 < attempts;

    if (willRetry) {
      keepScratch = true;
      log.warn({ err, code: appErr.code, stage }, "stage failed — BullMQ will retry");
      throw err;
    }
    if (appErr.code === "INTERNAL") log.error({ err, stage }, "run failed with an unexpected error");
    else log.warn({ code: appErr.code, stage, cause: appErr.cause }, "run failed");

    // A failed "Find new clips" leaves the earlier clips in place instead of failing the video.
    const request = claim.video.clipRequest;
    if (request?.status === "pending" && stage === "analyze" && claim.video.currentAnalysisRunId) {
      const recorded = await run.failClipRequest(appErr, request.previousStages ?? null);
      if (!recorded) return { outcome: "abandoned" };
      log.info({ code: appErr.code }, "new clips request failed — earlier clips kept");
      return { outcome: "ready" };
    }

    // The AI's daily quota is gone everywhere: wait for the reset instead of failing (a few times at most).
    const waits = claim.video.pipeline?.quotaWaits ?? 0;
    if (appErr.code === "AI_DAILY_CAP_REACHED" && waits < PIPELINE_TIMING.maxQuotaWaits) {
      const until = waitUntilFor(appErr);
      const recorded = await run.waitForQuota(stage, until);
      if (!recorded) return { outcome: "abandoned" };
      log.warn({ stage, until, waits: waits + 1 }, "AI quota used up — waiting for it to come back");
      return { outcome: "waiting", until };
    }

    const recorded = await run.fail(appErr, stage);
    if (!recorded) return { outcome: "abandoned" };
    throw new UnrecoverableError(appErr.code);
  } finally {
    run.stop();
    if (!keepScratch) {
      await rm(scratchDir, { recursive: true, force: true }).catch((err: unknown) =>
        log.warn({ err, scratchDir }, "couldn't remove scratch folder"),
      );
    }
  }
}
