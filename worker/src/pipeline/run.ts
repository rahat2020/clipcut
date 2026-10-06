import { Types } from "mongoose";

import { logger } from "../lib/logger";
import {
  AppError,
  newRunId,
  overallProgress,
  PIPELINE_TIMING,
  STAGE_NAMES,
  Video,
  type StageName,
  type StageStatus,
  type ActivityKind,
  type VideoDoc,
} from "../shared";

export type RunVideo = VideoDoc & { _id: Types.ObjectId };

/**
 * The run this worker was processing is no longer the video's current run: the user
 * deleted it, or a stuck-job sweep restarted it under a new run id. Stop quietly —
 * never write anything more for this run.
 */
export class RunLostError extends Error {
  constructor(readonly videoId: string) {
    super(`run no longer current for video ${videoId}`);
    this.name = "RunLostError";
  }
}

type StageState = { status: StageStatus; progress: number };

/** A transfer in progress, as reported by the downloaders (see lib/transfer.ts). */
export type ActivityReport = {
  kind: ActivityKind;
  doneBytes: number;
  totalBytes: number | null;
  bytesPerSec: number;
  etaSec: number | null;
};

export type ClaimResult = { kind: "started" | "resumed"; video: RunVideo } | { kind: "skip"; reason: string };

/**
 * Takes ownership of a run: `queued` → `processing`. A run that is already `processing`
 * with the same id is resumed (a BullMQ retry, or a job restarted after a worker crash).
 * Anything else — deleted, canceled, finished, or a newer run — is skipped.
 */
export async function claimRun(videoId: string, runId: string, jobId: string, now = new Date()): Promise<ClaimResult> {
  const _id = new Types.ObjectId(videoId);
  const started = await Video.updateOne(
    { _id, deletedAt: null, status: "queued", "pipeline.runId": runId },
    { $set: { status: "processing", "pipeline.jobId": jobId, "pipeline.heartbeatAt": now }, $unset: { "pipeline.waitUntil": 1 } },
  );
  const video = await Video.findById(_id).lean<RunVideo>();
  if (!video) return { kind: "skip", reason: "video not found" };
  if (video.deletedAt) return { kind: "skip", reason: "video deleted" };
  if (video.pipeline?.runId !== runId) return { kind: "skip", reason: "superseded by a newer run" };
  if (video.status !== "processing") return { kind: "skip", reason: `video is ${video.status}` };
  return { kind: started.modifiedCount === 1 ? "started" : "resumed", video };
}

/**
 * Every write for one run. Each update is filtered on this run id and `processing`
 * (the zombie guard, docs/SCHEMA.md §3.2): if it matches nothing, the run was taken
 * away and RunLostError stops the job. Progress writes are throttled to protect the
 * Atlas free tier's ops budget (docs/SCHEMA.md §5).
 */
export class PipelineRun {
  readonly videoId: string;
  private readonly _id: Types.ObjectId;
  private readonly stages: Record<StageName, StageState>;
  private readonly abort = new AbortController();
  private heartbeat: NodeJS.Timeout | null = null;
  private lastWriteAt = 0;
  private lastWrittenProgress = 0;
  private lastWrittenStageProgress = 0;
  private activity: ActivityReport | null = null;
  private activityWritten = false;
  private lastActivityWriteAt = 0;
  current: StageName | null = null;

  constructor(
    video: RunVideo,
    readonly runId: string,
  ) {
    this._id = video._id;
    this.videoId = String(video._id);
    this.stages = Object.fromEntries(
      STAGE_NAMES.map((name) => {
        const s = video.pipeline?.stages?.[name];
        return [name, { status: (s?.status ?? "pending") as StageStatus, progress: s?.progress ?? 0 }];
      }),
    ) as Record<StageName, StageState>;
    this.lastWrittenProgress = video.pipeline?.progress ?? 0;
  }

  /** Aborted when the run is lost; stage handlers pass it to long operations. */
  get signal(): AbortSignal {
    return this.abort.signal;
  }

  stageStatus(name: StageName): StageStatus {
    return this.stages[name].status;
  }

  private progress(): number {
    return overallProgress(this.stages);
  }

  private async write(update: Record<string, unknown>, options: { allowLost?: boolean } = {}): Promise<boolean> {
    const res = await Video.updateOne({ _id: this._id, "pipeline.runId": this.runId, status: "processing" }, update);
    if (res.matchedCount === 1) return true;
    this.abort.abort();
    if (options.allowLost) return false;
    throw new RunLostError(this.videoId);
  }

  startHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      this.write({ $set: { "pipeline.heartbeatAt": new Date() } }, { allowLost: true })
        .then((ok) => {
          if (!ok) logger.info({ videoId: this.videoId }, "run lost (deleted or restarted) — stopping");
        })
        .catch((err: unknown) => logger.warn({ err, videoId: this.videoId }, "heartbeat write failed"));
    }, PIPELINE_TIMING.heartbeatMs);
    this.heartbeat.unref();
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  async startStage(name: StageName): Promise<void> {
    this.current = name;
    this.lastWrittenStageProgress = 0;
    this.stages[name] = { status: "running", progress: 0 };
    const now = new Date();
    await this.write({
      $set: {
        "pipeline.stage": name,
        "pipeline.heartbeatAt": now,
        [`pipeline.stages.${name}.status`]: "running",
        [`pipeline.stages.${name}.progress`]: 0,
        [`pipeline.stages.${name}.startedAt`]: now,
      },
      $unset: { [`pipeline.stages.${name}.finishedAt`]: 1 },
      $inc: { [`pipeline.stages.${name}.attempts`]: 1 },
    });
  }

  /**
   * Progress inside the current stage (0..1). Written at most every few seconds, and only
   * when the overall bar or this stage moved enough to show (a long download inside a
   * small stage still visibly moves the stage's own percentage).
   */
  async reportProgress(fraction: number): Promise<void> {
    const name = this.current;
    if (!name) return;
    this.stages[name].progress = Math.min(Math.max(fraction, 0), 1);
    const now = Date.now();
    if (now - this.lastWriteAt < PIPELINE_TIMING.progressWriteMs) return;
    const overall = this.progress();
    const stageStep = this.stages[name].progress - this.lastWrittenStageProgress;
    const activityDue = !!this.activity && now - this.lastActivityWriteAt >= PIPELINE_TIMING.activityWriteMs;
    if (
      overall - this.lastWrittenProgress < PIPELINE_TIMING.progressMinStep &&
      stageStep < PIPELINE_TIMING.stageProgressMinStep &&
      !activityDue
    ) {
      return;
    }
    await this.flushProgress(name, now);
  }

  /**
   * Live transfer details (bytes, speed, time left) for the user, e.g. while downloading.
   * Written along with progress, at most every PIPELINE_TIMING.activityWriteMs.
   */
  async reportActivity(activity: ActivityReport, options: { force?: boolean } = {}): Promise<void> {
    this.activity = activity;
    const name = this.current;
    const now = Date.now();
    if (!name) return;
    if (!options.force) {
      if (now - this.lastWriteAt < PIPELINE_TIMING.progressWriteMs) return;
      if (now - this.lastActivityWriteAt < PIPELINE_TIMING.activityWriteMs) return;
    }
    await this.flushProgress(name, now);
  }

  /** Stops showing the transfer (download finished). */
  async clearActivity(): Promise<void> {
    this.activity = null;
    if (!this.activityWritten) return;
    this.activityWritten = false;
    await this.write({ $unset: { "pipeline.activity": 1 } });
  }

  private async flushProgress(name: StageName, now: number): Promise<void> {
    const overall = this.progress();
    this.lastWriteAt = now;
    this.lastWrittenProgress = overall;
    this.lastWrittenStageProgress = this.stages[name].progress;
    const set: Record<string, unknown> = {
      "pipeline.progress": overall,
      "pipeline.heartbeatAt": new Date(now),
      [`pipeline.stages.${name}.progress`]: this.stages[name].progress,
    };
    if (this.activity) {
      const a = this.activity;
      set["pipeline.activity"] = {
        kind: a.kind,
        doneBytes: a.doneBytes,
        ...(a.totalBytes != null ? { totalBytes: a.totalBytes } : {}),
        bytesPerSec: a.bytesPerSec,
        ...(a.etaSec != null ? { etaSec: a.etaSec } : {}),
        at: new Date(now),
      };
      this.lastActivityWriteAt = now;
      this.activityWritten = true;
    }
    await this.write({ $set: set });
  }

  async finishStage(name: StageName, status: "done" | "skipped" = "done"): Promise<void> {
    this.stages[name] = { status, progress: 1 };
    const overall = this.progress();
    this.lastWrittenProgress = overall;
    await this.write({
      $set: {
        "pipeline.progress": overall,
        "pipeline.heartbeatAt": new Date(),
        [`pipeline.stages.${name}.status`]: status,
        [`pipeline.stages.${name}.progress`]: 1,
        [`pipeline.stages.${name}.finishedAt`]: new Date(),
      },
      $unset: { "pipeline.activity": 1 },
    });
    this.activity = null;
    this.activityWritten = false;
    this.current = null;
  }

  /** Saves stage results on the video (e.g. `media`, `audio`), guarded like every run write. */
  async setFields(fields: Record<string, unknown>): Promise<void> {
    await this.write({ $set: { ...fields, "pipeline.heartbeatAt": new Date() } });
  }

  /** Removes fields from the video (e.g. a one-off request once it has been handled). */
  async unsetFields(paths: string[]): Promise<void> {
    await this.write({
      $unset: Object.fromEntries(paths.map((p) => [p, 1])),
      $set: { "pipeline.heartbeatAt": new Date() },
    });
  }

  async markReady(): Promise<void> {
    const now = new Date();
    await this.write({
      $set: { status: "ready", "pipeline.stage": null, "pipeline.progress": 1, "pipeline.quotaWaits": 0 },
      // $min: "Find new clips" runs never restart the retention clock (retry and admin re-run unset it first).
      $min: { "retention.finishedAt": now },
      $unset: { error: 1, "pipeline.activity": 1 },
    });
    this.stop();
  }

  /**
   * The AI's daily quota is used up everywhere (Step 17): instead of failing, the video goes back
   * to `queued` under a new run id and the dispatcher leaves it alone until `until`. Finished
   * stages stay finished; the stage that ran out starts again. Returns false if the run was lost.
   */
  async waitForQuota(stage: StageName | null, until: Date): Promise<boolean> {
    const set: Record<string, unknown> = { status: "queued", "pipeline.runId": newRunId(), "pipeline.waitUntil": until, "pipeline.stage": null };
    if (stage) {
      set[`pipeline.stages.${stage}.status`] = "pending";
      set[`pipeline.stages.${stage}.progress`] = 0;
    }
    const ok = await this.write(
      { $set: set, $inc: { "pipeline.quotaWaits": 1 }, $unset: { error: 1, "pipeline.jobId": 1, "pipeline.heartbeatAt": 1, "pipeline.activity": 1 } },
      { allowLost: true },
    );
    this.stop();
    return ok;
  }

  /**
   * Ends the run as failed with a user-safe error. `stage` is where it happened
   * (defaults to the current stage). Returns false if the run was already lost.
   */
  async fail(err: AppError, stage: StageName | null = this.current): Promise<boolean> {
    const now = new Date();
    const set: Record<string, unknown> = {
      status: "failed",
      error: { code: err.code, message: err.message, ...(stage ? { stage } : {}), retryable: err.retryable, at: now },
    };
    if (stage) {
      set[`pipeline.stages.${stage}.status`] = "failed";
      set[`pipeline.stages.${stage}.finishedAt`] = now;
    }
    const ok = await this.write({ $set: set, $min: { "retention.finishedAt": now }, $unset: { "pipeline.activity": 1 } }, { allowLost: true });
    this.stop();
    return ok;
  }

  /**
   * A "Find new clips" request failed while the video still has its earlier clips (Step 14):
   * the video goes back to `ready` with those clips, the request records why, and the
   * request isn't counted against the user (it was our failure, not theirs).
   */
  async failClipRequest(err: AppError, previous: Partial<Record<"analyze" | "copy" | "render", StageStatus | null>> | null): Promise<boolean> {
    const now = new Date();
    const set: Record<string, unknown> = {
      status: "ready",
      "pipeline.stage": null,
      "pipeline.progress": 1,
      "clipRequest.status": "failed",
      "clipRequest.errorCode": err.code,
      "clipRequest.finishedAt": now,
    };
    for (const name of ["analyze", "copy", "render"] as const) {
      set[`pipeline.stages.${name}.status`] = previous?.[name] ?? "done";
      set[`pipeline.stages.${name}.progress`] = 1;
    }
    const ok = await this.write(
      { $set: set, $unset: { error: 1, "pipeline.activity": 1 }, $inc: { "counts.clipRequests": -1 } },
      { allowLost: true },
    );
    this.stop();
    return ok;
  }
}
