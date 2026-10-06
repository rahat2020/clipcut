// GENERATED — do not edit. Source: shared/src/pipeline.ts
// Edit the source, then run: node scripts/sync-shared.mjs

/**
 * The video pipeline's contract between web/ and worker/: queue names, job payloads,
 * how overall progress is computed, and the timing rules for recovery.
 *
 * No BullMQ import here — web/ never talks to the queue (docs/DECISIONS.md D35). The
 * worker's dispatcher moves `queued` videos from MongoDB into BullMQ.
 */
import { randomUUID } from "node:crypto";

import { STAGE_NAMES, type StageName } from "./enums";

/** BullMQ queue names (no ":" allowed). */
export const QUEUES = { pipeline: "video-pipeline", render: "clip-render" } as const;

export const PIPELINE_JOB_NAME = "process-video";
export const RENDER_JOB_NAME = "render-clip";

/**
 * One render the user asked for (the pipeline renders its top clips itself). `queuedAt`
 * is part of the job id: a render queued again (retry, stuck) gets a new job.
 */
export type RenderJobData = { v: 1; renderId: string; queuedAt: number };

export function renderJobId(renderId: string, queuedAt: number): string {
  return `render-${renderId}-${queuedAt}`;
}

/** Bump `v` when the payload shape changes; the worker rejects versions it doesn't know. */
export type PipelineJobData = { v: 1; videoId: string; runId: string };

/** One BullMQ job per run, so enqueueing the same run twice is a no-op. */
export function pipelineJobId(videoId: string, runId: string): string {
  return `${videoId}-${runId}`;
}

/** A fresh run id: every (re)process of a video gets one (the zombie guard, docs/SCHEMA.md §3.2). */
export function newRunId(): string {
  return randomUUID();
}

/**
 * Share of the whole job each stage represents, for the single progress bar.
 * Rough wall-clock shares for a 30-minute video; they only need to feel right.
 */
export const STAGE_WEIGHTS: Record<StageName, number> = {
  ingest: 0.05,
  audio: 0.05,
  transcribe: 0.25,
  analyze: 0.15,
  copy: 0.1,
  render: 0.4,
};

type StageProgressView = { status?: string | null; progress?: number | null } | null | undefined;

/** Overall progress 0..1 from the per-stage states (done and skipped count as complete). */
export function overallProgress(stages: Partial<Record<StageName, StageProgressView>>): number {
  let total = 0;
  for (const name of STAGE_NAMES) {
    const s = stages[name];
    const share = s?.status === "done" || s?.status === "skipped" ? 1 : Math.min(Math.max(s?.progress ?? 0, 0), 1);
    total += STAGE_WEIGHTS[name] * share;
  }
  return Math.round(total * 1000) / 1000;
}

/**
 * Each running worker keeps one Redis key alive (docs/SCHEMA.md §3.11); the admin panel
 * lists them to show which workers are up and how big the queue is.
 */
export const WORKER_PRESENCE = {
  pattern: "worker:*:heartbeat",
  key: (workerId: string) => `worker:${workerId}:heartbeat`,
  ttlSeconds: 60,
  intervalMs: 20_000,
} as const;

export type WorkerPresence = {
  id: string;
  startedAt: string;
  at: string;
  concurrency: number;
  activeJobs: number;
  queue: { waiting: number; active: number; delayed: number; failed: number };
};

/** The cleanup job (Step 17, docs/SCHEMA.md §8). */
export const CLEANUP_TIMING = {
  /** Database-driven sweeps (expired, deleted, abandoned, purge). */
  everyMs: 30 * 60_000,
  /** Cloudinary-wide scan for files no video owns. */
  orphanScanEveryMs: 24 * 60 * 60_000,
  /** A draft (upload ticket made, never finished) older than this is abandoned. */
  abandonedDraftHours: 48,
  /** Files younger than this are never called orphans (an upload may still be being recorded). */
  orphanMinAgeHours: 24,
  /** Videos handled per sweep per run — keeps Cloudinary's Admin API (500 calls/hour free) and Atlas ops low. */
  batch: 20,
  /** Orphaned videos deleted per scan; more are reported and left for the next scan. */
  maxOrphanVideos: 20,
  /** Cloudinary list pages per kind per scan (500 files each). */
  maxListPages: 10,
  /** One cleanup at a time across workers (Redis lock lifetime). */
  lockSeconds: 15 * 60,
} as const;

/** The database backup (Step 17, D53). */
export const BACKUP_TIMING = {
  /** The worker looks this often whether a backup is due… */
  checkEveryMs: 3 * 60 * 60_000,
  /** …and makes one when the last good one is older than this. */
  minGapMs: 20 * 60 * 60_000,
  /** Backups kept in Cloudinary (the newest). */
  keep: 7,
  /** Cloudinary's free plan refuses larger raw files; a bigger backup is reported loudly instead of failing quietly. */
  maxBytes: 9 * 1024 * 1024,
  /** Redis keys: the lock (one backup at a time) and the last result (the admin panel reads it, Step 16). */
  lockKey: "backup:lock",
  lastKey: "backup:last",
  lockSeconds: 15 * 60,
} as const;

/** What the worker stores in Redis `backup:last` after each try (the admin panel shows it). */
export type LastBackup = { at: string; bytes: number; docs: number; file: string; error?: undefined } | { at: string; error: string };

export const PIPELINE_TIMING = {
  /** Worker touches `pipeline.heartbeatAt` this often while a job runs. */
  heartbeatMs: 30_000,
  /**
   * A `processing` video whose heartbeat is older than this is considered stuck (four
   * missed heartbeats). FFmpeg runs in a child process, so a busy job still beats.
   */
  stuckAfterMs: 2 * 60_000,
  /** How often the worker moves queued videos into BullMQ. */
  dispatchEveryMs: 5_000,
  /** How often the worker looks for stuck runs (also once at startup). */
  recoverEveryMs: 60_000,
  /** How many times a stuck run is restarted before the video is marked failed. */
  maxRecoveries: 3,
  /** How many times a video waits for the AI's daily quota before it is marked failed (Step 17). */
  maxQuotaWaits: 3,
  /** Progress writes: at most one per this interval per video (docs/SCHEMA.md §5). */
  progressWriteMs: 3_000,
  /** …and only when overall progress moved at least this much… */
  progressMinStep: 0.02,
  /** …or the current stage's own progress moved at least this much. */
  stageProgressMinStep: 0.1,
  /** Download speed / time left (`pipeline.activity`) refresh at most this often. */
  activityWriteMs: 5_000,
} as const;
