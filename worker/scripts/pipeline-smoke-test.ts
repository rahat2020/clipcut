/**
 * Proves the queue + pipeline skeleton works against the real Atlas cluster and Redis.
 *
 *   npm run pipeline:smoke
 *
 * Throwaway database (<MONGODB_DB>_pipelinetest, dropped) and its own BullMQ key prefix
 * (removed), so real videos and the real queue are never touched. Stage code is faked;
 * this tests the machinery: dispatch, claim, retries, zombie guard, cancel, recovery.
 */
import path from "node:path";

import { UnrecoverableError, Worker, type Job } from "bullmq";
import mongoose, { Types } from "mongoose";

import { env } from "../src/config/env";
import { connectDb, disconnectDb } from "../src/lib/db";
import { logger } from "../src/lib/logger";
import { TransferMeter } from "../src/lib/transfer";
import { bullConnection } from "../src/lib/redis";
import { runShutdownHooks } from "../src/lib/shutdown";
import { assertLengthAllowed } from "../src/pipeline/limits";
import { chargeMinutes } from "../src/pipeline/usage";
import { Dispatcher } from "../src/pipeline/dispatcher";
import { pickFinalError } from "../src/services/ai/llm";
import { nextPacificMidnight, nextUtcMidnight, quotaResumeAt } from "../src/services/ai/reset-time";
import type { StageHandler } from "../src/pipeline/stages/types";
import { processPipelineJob, type ProcessorDeps } from "../src/processors/pipeline-processor";
import { createPipelineQueue, enqueueRun } from "../src/queues/pipeline-queue";
import {
  AppError,
  clearSettingsCache,
  defaultSettings,
  newRunId,
  PIPELINE_TIMING,
  pipelineJobId,
  planLimitsSchema,
  QUEUES,
  STAGE_NAMES,
  updateSettings,
  UsageEvent,
  User,
  Video,
  videoWasCharged,
  type PipelineJobData,
  type StageName,
} from "../src/shared";

logger.level = "silent";

const TEST_DB = `${env.MONGODB_DB}_pipelinetest`;
const PREFIX = `smoketest-${Date.now().toString(36)}`;
const SCRATCH = path.join(env.SCRATCH_DIR, "pipeline-smoke");
const actor = { email: "smoke-test@local", userId: null };

type Result = { name: string; ok: boolean; detail?: string };
const results: Result[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const userId = new Types.ObjectId();

async function newVideo(extra: Record<string, unknown> = {}) {
  const doc = await Video.create({
    userId,
    title: "Pipeline smoke test",
    language: "bn",
    source: { type: "upload", originalFilename: "test.mp4" },
    permission: { confirmedAt: new Date(), termsVersion: "2026-09-28" },
    status: "queued",
    ...extra,
  });
  return doc._id;
}

function load(_id: Types.ObjectId) {
  return Video.findById(_id).lean().orFail();
}

/** A stand-in for BullMQ's Job, for calling the processor directly. */
function fakeJob(videoId: Types.ObjectId, runId: string, attemptsMade = 0, attempts = 3): Job<PipelineJobData> {
  return {
    id: pipelineJobId(String(videoId), runId),
    data: { v: 1, videoId: String(videoId), runId },
    attemptsMade,
    opts: { attempts },
  } as unknown as Job<PipelineJobData>;
}

const ok: StageHandler = async ({ run }) => {
  await run.reportProgress(1);
};
const allStages = Object.fromEntries(STAGE_NAMES.map((s) => [s, ok])) as Record<StageName, StageHandler>;
const deps = (handlers: ProcessorDeps["handlers"]): ProcessorDeps => ({ scratchRoot: SCRATCH, handlers });

async function expectThrows(p: Promise<unknown>, check: (e: unknown) => boolean, what: string) {
  try {
    await p;
  } catch (e) {
    assert(check(e), `${what}: unexpected error ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  throw new Error(`${what}: expected an error`);
}

async function main() {
  console.log(`\nPipeline smoke test → db "${TEST_DB}", Redis prefix "${PREFIX}" (both removed afterwards)\n`);
  await connectDb({ dbName: TEST_DB, autoIndex: false });
  const db = mongoose.connection.db!;
  for (const c of await db.listCollections().toArray()) await db.dropCollection(c.name);
  await Video.createCollection();
  await Video.createIndexes();
  await UsageEvent.createIndexes(); // production has it (`npm run db:indexes`); it is what stops a double charge
  clearSettingsCache();

  const queue = createPipelineQueue({ prefix: PREFIX, jobOptions: { backoff: { type: "fixed", delay: 300 } } });
  const dispatcher = new Dispatcher(queue);

  try {
    // ── dispatcher ──
    await test("dispatch: a queued video without a run gets a run id and exactly one job", async () => {
      const id = await newVideo();
      const first = await dispatcher.dispatchQueued();
      const second = await new Dispatcher(queue).dispatchQueued(); // a fresh dispatcher re-adds: must be a no-op
      const v = await load(id);
      assert(v.pipeline?.runId, "no runId assigned");
      assert(first.enqueued === 1, `enqueued ${first.enqueued}`);
      assert(second.enqueued === 1, "second dispatcher should also report its add");
      const counts = await queue.getJobCounts("waiting");
      assert(counts.waiting === 1, `waiting jobs: ${counts.waiting} (duplicate job?)`);
      assert(await queue.getJob(pipelineJobId(String(id), v.pipeline.runId)), "job id isn't <videoId>-<runId>");
      await queue.drain();
      await Video.deleteOne({ _id: id });
    });

    await test("dispatch: deleted videos are never enqueued; processing switch off → nothing enqueued", async () => {
      await newVideo({ deletedAt: new Date(), status: "canceled" });
      const live = await newVideo();
      await updateSettings("system", { ...defaultSettings("system"), processingEnabled: false }, { expectedVersion: 0, actor });
      clearSettingsCache();
      const paused = await dispatcher.dispatchQueued();
      assert(paused.skippedPaused && paused.enqueued === 0, "enqueued while processing was switched off");
      await updateSettings("system", { ...defaultSettings("system"), processingEnabled: true }, { expectedVersion: 1, actor });
      clearSettingsCache();
      const r = await dispatcher.dispatchQueued();
      assert(r.enqueued === 1, `enqueued ${r.enqueued}, expected only the live video`);
      await queue.drain();
      await Video.deleteMany({});
      void live;
    });

    // ── processor ──
    await test("run: all stages → ready, progress 1, every stage done, retention clock started", async () => {
      const runId = newRunId();
      const id = await newVideo({ pipeline: { runId } });
      const out = await processPipelineJob(fakeJob(id, runId), deps(allStages));
      const v = await load(id);
      assert(out.outcome === "ready", `outcome ${out.outcome}`);
      assert(v.status === "ready" && v.pipeline?.progress === 1, `status ${v.status}, progress ${v.pipeline?.progress}`);
      assert(STAGE_NAMES.every((s) => v.pipeline?.stages?.[s]?.status === "done"), "a stage isn't done");
      assert(v.retention?.finishedAt, "retention.finishedAt not set");
    });

    await test("run: stage not built yet → failed STAGE_NOT_READY at that stage, earlier stages kept", async () => {
      const runId = newRunId();
      const id = await newVideo({ pipeline: { runId } });
      await expectThrows(
        processPipelineJob(fakeJob(id, runId), deps({ ingest: ok, audio: ok })),
        (e) => e instanceof UnrecoverableError,
        "processor",
      );
      const v = await load(id);
      assert(v.status === "failed" && v.error?.code === "STAGE_NOT_READY", `status ${v.status} / ${v.error?.code}`);
      assert(v.error?.stage === "transcribe", `error stage ${v.error?.stage}`);
      assert(v.pipeline?.stages?.audio?.status === "done", "audio should stay done");
      assert(v.pipeline?.stages?.transcribe?.status === "failed", "transcribe should be failed");
      assert(Math.abs((v.pipeline?.progress ?? 0) - 0.1) < 0.001, `progress ${v.pipeline?.progress}`);
    });

    await test("run: non-retryable error (no audio) → failed on the first attempt", async () => {
      const runId = newRunId();
      const id = await newVideo({ pipeline: { runId } });
      const noAudio: StageHandler = async () => {
        throw new AppError("NO_AUDIO_TRACK");
      };
      await expectThrows(
        processPipelineJob(fakeJob(id, runId, 0, 3), deps({ ...allStages, ingest: noAudio })),
        (e) => e instanceof UnrecoverableError,
        "processor",
      );
      const v = await load(id);
      assert(v.status === "failed" && v.error?.code === "NO_AUDIO_TRACK" && v.error.retryable === false, `got ${v.error?.code}`);
    });

    await test("quota: every AI model out of quota → the video waits (queued + resume time, new run, stage restarts) and the dispatcher leaves it alone until then", async () => {
      const runId = newRunId();
      const id = await newVideo({ pipeline: { runId, stages: { ingest: { status: "done", progress: 1 }, audio: { status: "done", progress: 1 } } } });
      const until = new Date(Date.now() + 6 * 3_600_000);
      const outOfQuota: StageHandler = async () => {
        throw new AppError("AI_DAILY_CAP_REACHED", { details: { resumeAt: until.toISOString() } });
      };
      const out = await processPipelineJob(fakeJob(id, runId), deps({ ...allStages, transcribe: outOfQuota }));
      const v = await load(id);
      assert(out.outcome === "waiting", `outcome ${out.outcome}`);
      assert(v.status === "queued" && !v.error && v.pipeline?.runId && v.pipeline.runId !== runId, `status ${v.status}, run ${v.pipeline?.runId}`);
      assert(v.pipeline?.waitUntil?.getTime() === until.getTime() && v.pipeline.quotaWaits === 1, `waitUntil ${v.pipeline?.waitUntil}, waits ${v.pipeline?.quotaWaits}`);
      assert(v.pipeline?.stages?.ingest?.status === "done" && v.pipeline.stages.transcribe?.status === "pending", "finished stages must stay, the stopped one restarts");

      const early = await new Dispatcher(queue).dispatchQueued();
      assert(early.enqueued === 0, `dispatched ${early.enqueued} before the quota came back`);
      const later = await new Dispatcher(queue).dispatchQueued(until.getTime() + 1000);
      assert(later.enqueued === 1, `dispatched ${later.enqueued} after the quota came back`);
      await queue.drain();

      // It runs again and finishes: the wait is cleared and the counter reset.
      const out2 = await processPipelineJob(fakeJob(id, v.pipeline!.runId!), deps(allStages));
      const done = await load(id);
      assert(out2.outcome === "ready" && !done.pipeline?.waitUntil && done.pipeline?.quotaWaits === 0, `outcome ${out2.outcome}, waits ${done.pipeline?.quotaWaits}`);

      // After the last allowed wait the video fails (the user can retry), instead of waiting forever.
      const runId3 = newRunId();
      const id3 = await newVideo({ pipeline: { runId: runId3, quotaWaits: PIPELINE_TIMING.maxQuotaWaits } });
      await expectThrows(processPipelineJob(fakeJob(id3, runId3), deps({ ...allStages, ingest: outOfQuota })), (e) => e instanceof UnrecoverableError, "processor");
      const failed = await load(id3);
      assert(failed.status === "failed" && failed.error?.code === "AI_DAILY_CAP_REACHED" && failed.error.retryable === true, `got ${failed.status} ${failed.error?.code}`);
    });

    await test("quota: reset times (Pacific midnight in summer and winter time, UTC midnight) and which errors count as 'out of quota'", async () => {
      const at = (iso: string) => new Date(iso);
      assert(nextPacificMidnight(at("2026-10-03T12:00:00Z")).toISOString() === "2026-10-04T07:02:00.000Z", nextPacificMidnight(at("2026-10-03T12:00:00Z")).toISOString());
      assert(nextPacificMidnight(at("2026-12-03T12:00:00Z")).toISOString() === "2026-12-04T08:02:00.000Z", "winter");
      assert(nextPacificMidnight(at("2026-11-01T05:00:00Z")).toISOString() === "2026-11-01T07:02:00.000Z", "the night before daylight saving ends");
      assert(nextPacificMidnight(at("2026-11-01T12:00:00Z")).toISOString() === "2026-11-02T08:02:00.000Z", "the day daylight saving ends");
      assert(nextUtcMidnight(at("2026-10-03T23:59:00Z")).toISOString() === "2026-10-04T00:02:00.000Z", "UTC");
      assert(quotaResumeAt(at("2026-10-03T12:00:00Z"), { gemini: true, ours: false }).toISOString() === "2026-10-04T07:02:00.000Z", "gemini only");
      assert(quotaResumeAt(at("2026-10-03T12:00:00Z"), { gemini: true, ours: true }).toISOString() === "2026-10-04T00:02:00.000Z", "our cap resets first");

      const day = (provider: string) => new AppError("AI_UNAVAILABLE", { details: { provider, quotaDay: true, noRetry: true } });
      const big = new AppError("AI_UNAVAILABLE", { details: { provider: "groq", tooLarge: true, noRetry: true } });
      const now = at("2026-10-03T12:00:00Z");
      const allDay = pickFinalError([day("gemini"), day("gemini"), big], now);
      assert(allDay.code === "AI_DAILY_CAP_REACHED" && allDay.details?.resumeAt === "2026-10-04T07:02:00.000Z", `${allDay.code} ${allDay.details?.resumeAt}`);
      assert(pickFinalError([new AppError("AI_DAILY_CAP_REACHED"), new AppError("AI_DAILY_CAP_REACHED")], now).details?.resumeAt === "2026-10-04T00:02:00.000Z", "our caps");
      assert(pickFinalError([day("gemini"), new AppError("AI_UNAVAILABLE", { details: { provider: "gemini", status: 503 } })], now).code === "AI_UNAVAILABLE", "a busy model among them: plain unavailable (retried), not a wait");
      assert(pickFinalError([big], now).code === "AI_UNAVAILABLE", "too large alone is not a quota problem");
      assert(pickFinalError([day("gemini"), new AppError("INTERNAL", { retryable: false })], now).code === "INTERNAL", "a config error stays visible");
    });

    await test("minutes: charged exactly once however often a video is retried or re-run; a charged video isn't refused for lack of minutes again, an uncharged one is", async () => {
      const user = await User.create({ clerkId: "user_ps_minutes", email: "ps-minutes@example.com", quota: { periodStart: new Date(), minutesUsed: 195 } });
      const id = await newVideo({ userId: user._id, status: "failed" });
      const limits = planLimitsSchema.parse({ monthlyMinutes: 200 });
      const tenMinutes = 10 * 60_000;

      const used195 = { quota: { periodStart: new Date(), minutesUsed: 195 } };
      let code = "";
      try {
        assertLengthAllowed(tenMinutes, used195, limits);
      } catch (e) {
        code = (e as AppError).code;
      }
      assert(code === "QUOTA_EXCEEDED" && !(await videoWasCharged(id)), `uncharged: got "${code}"`);

      const charges = [] as boolean[];
      for (let i = 0; i < 3; i++) charges.push(await chargeMinutes({ userId: user._id, videoId: id, minutes: 10, provider: "gemini", model: "x" }));
      assert(charges.join() === "true,false,false" && (await videoWasCharged(id)), `charges ${charges}`);
      const after = await User.findById(user._id).lean().orFail();
      assert(after.quota?.minutesUsed === 205, `counter ${after.quota?.minutesUsed}, expected 205 (charged once)`);

      // Now it is in the total (205 of 200): re-running it must not be refused, but it must still fit the plan's length.
      const used205 = { quota: { periodStart: new Date(), minutesUsed: 205 } };
      assertLengthAllowed(tenMinutes, used205, limits, new Date(), true);
      let tooLong = "";
      try {
        assertLengthAllowed((limits.maxDurationMin + 1) * 60_000, used205, limits, new Date(), true);
      } catch (e) {
        tooLong = (e as AppError).code;
      }
      assert(tooLong === "VIDEO_TOO_LONG", `length rule skipped: "${tooLong}"`);
    });

    await test("run: retryable error on a non-final attempt → rethrown, video stays processing", async () => {
      const runId = newRunId();
      const id = await newVideo({ pipeline: { runId } });
      const busy: StageHandler = async () => {
        throw new AppError("AI_UNAVAILABLE");
      };
      await expectThrows(
        processPipelineJob(fakeJob(id, runId, 0, 3), deps({ ...allStages, analyze: busy })),
        (e) => e instanceof AppError && e.code === "AI_UNAVAILABLE",
        "processor",
      );
      const v = await load(id);
      assert(v.status === "processing" && !v.error, `status ${v.status}`);
      // …and on the final attempt the same error fails the video.
      await expectThrows(
        processPipelineJob(fakeJob(id, runId, 2, 3), deps({ ...allStages, analyze: busy })),
        (e) => e instanceof UnrecoverableError,
        "final attempt",
      );
      const after = await load(id);
      assert(after.status === "failed" && after.error?.code === "AI_UNAVAILABLE", `status ${after.status}`);
      assert(after.pipeline?.stages?.analyze?.attempts === 2, `analyze attempts ${after.pipeline?.stages?.analyze?.attempts}`);
    });

    await test("run: resume skips finished stages (their code is not called again)", async () => {
      const runId = newRunId();
      const id = await newVideo({
        status: "processing",
        pipeline: { runId, stages: { ingest: { status: "done", progress: 1 }, audio: { status: "done", progress: 1 } } },
      });
      const called: StageName[] = [];
      const spy = Object.fromEntries(
        STAGE_NAMES.map((s) => [s, (async () => void called.push(s)) as StageHandler]),
      ) as Record<StageName, StageHandler>;
      const out = await processPipelineJob(fakeJob(id, runId, 1), deps(spy));
      assert(out.outcome === "ready", `outcome ${out.outcome}`);
      assert(!called.includes("ingest") && !called.includes("audio"), `re-ran: ${called.join(",")}`);
      assert(called.length === 4, `called ${called.join(",")}`);
    });

    await test("activity: download speed/time left shown while running, cleared when the stage ends", async () => {
      const runId = newRunId();
      const id = await newVideo({ pipeline: { runId } });
      let during: unknown = null;
      const downloading: StageHandler = async ({ run }) => {
        await run.reportActivity({ kind: "download_youtube", doneBytes: 1_000_000, totalBytes: 5_000_000, bytesPerSec: 250_000, etaSec: 16 });
        during = (await load(id)).pipeline?.activity;
      };
      await processPipelineJob(fakeJob(id, runId), deps({ ...allStages, ingest: downloading }));
      const a = during as { kind?: string; etaSec?: number; bytesPerSec?: number } | null;
      assert(a?.kind === "download_youtube" && a.etaSec === 16 && a.bytesPerSec === 250_000, `during: ${JSON.stringify(a)}`);
      const v = await load(id);
      assert(!v.pipeline?.activity, "activity not cleared after the stage");
    });

    await test("transfer meter: speed from recent readings, time left, reset on a new stream", async () => {
      const m = new TransferMeter();
      m.update(0, 10_000_000, 0);
      const s = m.update(2_000_000, 10_000_000, 4_000); // 500 KB/s
      assert(s.bytesPerSec === 500_000 && s.etaSec === 16, JSON.stringify(s));
      const r = m.update(100, 3_000_000, 5_000); // audio stream starts: bytes went down
      assert(r.bytesPerSec === 0 && r.etaSec === null, `after reset: ${JSON.stringify(r)}`);
    });

    await test("claim: a job for an old run id is skipped and changes nothing", async () => {
      const id = await newVideo({ pipeline: { runId: newRunId() } });
      const out = await processPipelineJob(fakeJob(id, newRunId()), deps(allStages));
      const v = await load(id);
      assert(out.outcome === "skipped", `outcome ${out.outcome}`);
      assert(v.status === "queued", `status ${v.status}`);
    });

    await test("zombie guard: run restarted mid-stage → old run stops without writing", async () => {
      const runId = newRunId();
      const id = await newVideo({ pipeline: { runId } });
      const newer = newRunId();
      const hijack: StageHandler = async ({ run }) => {
        await Video.updateOne({ _id: id }, { $set: { status: "queued", "pipeline.runId": newer } });
        await run.reportProgress(0.5); // throttled: no write yet
      };
      const out = await processPipelineJob(fakeJob(id, runId), deps({ ...allStages, ingest: hijack }));
      const v = await load(id);
      assert(out.outcome === "abandoned", `outcome ${out.outcome}`);
      assert(v.status === "queued" && v.pipeline?.runId === newer, `status ${v.status}`);
      assert(v.pipeline?.stages?.ingest?.status === "running", "old run wrote after losing the video");
    });

    await test("cancel: user deletes mid-run → run abandoned, video stays canceled", async () => {
      const runId = newRunId();
      const id = await newVideo({ pipeline: { runId } });
      const del: StageHandler = async () => {
        await Video.updateOne({ _id: id }, { $set: { deletedAt: new Date(), status: "canceled" } });
      };
      const out = await processPipelineJob(fakeJob(id, runId), deps({ ...allStages, audio: del }));
      const v = await load(id);
      assert(out.outcome === "abandoned", `outcome ${out.outcome}`);
      assert(v.status === "canceled" && !v.error, `status ${v.status}`);
    });

    // ── stuck-job recovery ──
    await test("recovery: silent processing run → back to queued with a new run, running stage reset", async () => {
      const oldRun = newRunId();
      const stale = new Date(Date.now() - PIPELINE_TIMING.stuckAfterMs - 60_000);
      const id = await newVideo({
        status: "processing",
        pipeline: {
          runId: oldRun,
          stage: "transcribe",
          heartbeatAt: stale,
          stages: { ingest: { status: "done", progress: 1 }, transcribe: { status: "running" } },
        },
      });
      const fresh = await newVideo({ status: "processing", pipeline: { runId: newRunId(), heartbeatAt: new Date() } });
      const r = await dispatcher.recoverStuck();
      const v = await load(id);
      const f = await load(fresh);
      assert(r.restarted === 1, `restarted ${r.restarted}`);
      assert(v.status === "queued" && v.pipeline?.runId !== oldRun, "not re-queued under a new run");
      assert(v.pipeline?.recoveries === 1, `recoveries ${v.pipeline?.recoveries}`);
      assert(v.pipeline?.stages?.transcribe?.status === "pending", "running stage not reset");
      assert(v.pipeline?.stages?.ingest?.status === "done", "finished stage was reset");
      assert(f.status === "processing", "a healthy run was touched");
    });

    await test("recovery: after the restart limit → failed PROCESSING_STALLED (user can retry)", async () => {
      const id = await newVideo({
        status: "processing",
        pipeline: {
          runId: newRunId(),
          stage: "ingest",
          heartbeatAt: new Date(Date.now() - 3_600_000),
          recoveries: PIPELINE_TIMING.maxRecoveries,
        },
      });
      const r = await dispatcher.recoverStuck();
      const v = await load(id);
      assert(r.failed === 1, `failed ${r.failed}`);
      assert(v.status === "failed" && v.error?.code === "PROCESSING_STALLED" && v.error.retryable, `got ${v.error?.code}`);
    });

    // ── the real thing: Redis + BullMQ worker ──
    await test("end to end: dispatcher → BullMQ → worker, one retry on a busy provider, then ready", async () => {
      await Video.deleteMany({});
      const id = await newVideo();
      let calls = 0;
      const flaky: StageHandler = async () => {
        calls++;
        if (calls === 1) throw new AppError("AI_UNAVAILABLE");
      };
      const worker = new Worker<PipelineJobData>(
        QUEUES.pipeline,
        (job) => processPipelineJob(job, deps({ ...allStages, transcribe: flaky })),
        { connection: bullConnection(), prefix: PREFIX },
      );
      try {
        const done = new Promise<void>((resolve, reject) => {
          worker.on("completed", () => resolve());
          worker.on("failed", (job, err) => {
            if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) reject(err);
          });
          setTimeout(() => reject(new Error("timed out after 30 s")), 30_000);
        });
        await dispatcher.dispatchQueued();
        await done;
      } finally {
        await worker.close();
      }
      const v = await load(id);
      assert(v.status === "ready", `status ${v.status} ${v.error?.code ?? ""}`);
      assert(calls === 2, `transcribe called ${calls}×`);
      assert(v.pipeline?.stages?.transcribe?.attempts === 2, `attempts ${v.pipeline?.stages?.transcribe?.attempts}`);
      assert(v.pipeline?.jobId === pipelineJobId(String(id), v.pipeline?.runId ?? ""), "jobId not recorded");
    });

    await test("enqueue: adding the same run twice keeps one job", async () => {
      const runId = newRunId();
      const vid = String(new Types.ObjectId());
      await enqueueRun(queue, vid, runId);
      await enqueueRun(queue, vid, runId);
      const counts = await queue.getJobCounts("waiting");
      assert(counts.waiting === 1, `waiting ${counts.waiting}`);
    });
  } finally {
    await queue.obliterate({ force: true }).catch(() => {});
    await queue.close();
  }
}

async function cleanup() {
  const db = mongoose.connection.db;
  if (!db || db.databaseName !== TEST_DB) return;
  await db.dropDatabase().catch(async () => {
    for (const c of await db.listCollections().toArray()) await db.dropCollection(c.name);
  });
}

main()
  .catch((err: unknown) => {
    results.push({ name: "test run", ok: false, detail: err instanceof Error ? err.message : String(err) });
  })
  .finally(async () => {
    await cleanup().catch((err) => console.error("cleanup failed:", err));
    await disconnectDb().catch(() => {});
    await runShutdownHooks(() => {});
    for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.detail ? `\n      → ${r.detail}` : ""}`);
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n${passed}/${results.length} passed · test database and Redis keys removed\n`);
    process.exit(passed === results.length ? 0 : 1);
  });
