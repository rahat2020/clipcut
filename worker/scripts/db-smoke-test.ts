/**
 * Proves the database design works against the real Atlas cluster.
 *
 *   npm run db:smoke
 *
 * Runs in a throwaway database (<MONGODB_DB>_smoketest) that is dropped at the end, so
 * it never touches real data. Each test checks one rule from docs/SCHEMA.md.
 */
import mongoose, { Types } from "mongoose";

import { env } from "../src/config/env";
import { connectDb, disconnectDb } from "../src/lib/db";
import { assertUniqueIndexes, missingUniqueIndexes } from "../src/lib/indexes";
import { migrationStatus, runMigrations } from "../src/lib/migrations";
import {
  ALL_MODELS,
  AppError,
  AuditLog,
  Clip,
  clearSettingsCache,
  defaultSettings,
  effectiveExpiry,
  effectivePlanLimits,
  expiryCandidatesFilter,
  getSettingsSnapshot,
  isExpired,
  Render,
  Transcript,
  updateSettings,
  UsageEvent,
  User,
  Video,
  type RetentionSettings,
} from "../src/shared";

const TEST_DB = `${env.MONGODB_DB}_smoketest`;
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const actor = { email: "smoke-test@local", userId: null };

type Result = { name: string; ok: boolean; detail?: string };
const results: Result[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
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

async function expectReject(promise: Promise<unknown>, check: (err: unknown) => boolean, what: string): Promise<void> {
  try {
    await promise;
  } catch (err) {
    assert(check(err), `${what}: rejected, but with an unexpected error: ${err instanceof Error ? err.message : err}`);
    return;
  }
  throw new Error(`${what}: expected a rejection, but it succeeded`);
}

const isDup = (err: unknown) => (err as { code?: number }).code === 11000;
const isValidation = (err: unknown) => err instanceof mongoose.Error.ValidationError;

function newVideo(userId: Types.ObjectId, extra: Record<string, unknown> = {}) {
  return Video.create({
    userId,
    title: "Smoke test video",
    language: "bn",
    source: { type: "upload", originalFilename: "test.mp4" },
    permission: { confirmedAt: new Date(), termsVersion: "2026-09-28" },
    ...extra,
  });
}

async function main() {
  console.log(`\nDatabase smoke test → "${TEST_DB}" (dropped afterwards)\n`);
  await connectDb({ dbName: TEST_DB, autoIndex: false });
  const db = mongoose.connection.db!;

  // Start clean in case a previous run crashed before cleanup.
  for (const c of await db.listCollections().toArray()) await db.dropCollection(c.name);

  // ── setup: indexes, exactly like `npm run db:indexes` ──
  await test("indexes: every model's indexes can be created", async () => {
    for (const Model of ALL_MODELS as readonly mongoose.Model<unknown>[]) {
      await Model.createCollection();
      await Model.createIndexes();
    }
  });

  await test("indexes: a missing unique index is reported (the worker then refuses to start); present again → none missing", async () => {
    await mongoose.connection.db!.collection("usage_events").dropIndexes();
    const missing = await missingUniqueIndexes();
    assert(missing.length === 1 && /usage_events.*idempotencyKey/.test(missing[0]!), `missing: ${JSON.stringify(missing)}`);
    let refused = "";
    try {
      await assertUniqueIndexes();
    } catch (err) {
      refused = err instanceof Error ? err.message : String(err);
    }
    assert(/npm run db:indexes/.test(refused), `assertUniqueIndexes: "${refused}"`);
    await UsageEvent.createIndexes();
    assert((await missingUniqueIndexes()).length === 0, "still missing after createIndexes");
    await assertUniqueIndexes();
  });

  // ── settings on an empty database ──
  await test("settings: empty database returns full defaults at version 0", async () => {
    clearSettingsCache();
    const s = await getSettingsSnapshot("retention", { fresh: true });
    assert(s.version === 0, `version ${s.version}`);
    assert(s.value.plans.free?.days === 7, "free plan days should default to 7");
    assert(s.value.graceHours === 24, "graceHours should default to 24");
    const ai = await getSettingsSnapshot("ai", { fresh: true });
    assert(ai.value.clipSelection.fallbacks.at(-1)?.model === "openai/gpt-oss-120b", "nested defaults not filled (zod prefault)");
  });

  await test("settings: first save of a group (version 0 → 1) creates it", async () => {
    const snap = await updateSettings("system", { ...defaultSettings("system"), maintenanceMessage: "set before migration" }, {
      expectedVersion: 0,
      actor,
    });
    assert(snap.version === 1, `version ${snap.version}`);
  });

  // ── migrations ──
  await test("migrations: 0001 seeds settings and keeps existing ones", async () => {
    const applied = await runMigrations(db, () => {});
    assert(applied.includes("0001-seed-settings"), `applied: ${applied.join(",")}`);
    clearSettingsCache();
    const sys = await getSettingsSnapshot("system", { fresh: true });
    assert(sys.value.maintenanceMessage === "set before migration", "migration overwrote an existing settings doc");
    const ret = await getSettingsSnapshot("retention", { fresh: true });
    assert(ret.version === 1 && ret.value.plans.free?.days === 7, "retention not seeded");
  });

  await test("migrations: second run is a no-op", async () => {
    const applied = await runMigrations(db, () => {});
    const status = await migrationStatus(db);
    assert(applied.length === 0, `re-applied: ${applied.join(",")}`);
    assert(status.pending.length === 0, "pending after run");
  });

  // ── settings: versioning, retention stamp, audit ──
  await test("settings: saving with a stale version is rejected (SETTINGS_CONFLICT)", async () => {
    const snap = await getSettingsSnapshot("retention", { fresh: true });
    const next = { ...snap.value, plans: { free: { days: 3 } } };
    const saved = await updateSettings("retention", next, { expectedVersion: snap.version, actor });
    assert(saved.version === snap.version + 1, "version not incremented");
    await expectReject(
      updateSettings("retention", next, { expectedVersion: snap.version, actor }),
      (e) => e instanceof AppError && e.code === "SETTINGS_CONFLICT",
      "stale save",
    );
  });

  await test("settings: changing retention days stamps changedAt; other edits keep it", async () => {
    const a = await getSettingsSnapshot("retention", { fresh: true });
    assert(a.value.changedAt instanceof Date, "changedAt not set after days changed");
    assert(Date.now() - a.value.changedAt.getTime() < 60_000, "changedAt is not recent");
    const b = await updateSettings("retention", { ...a.value, graceHours: 12 }, { expectedVersion: a.version, actor });
    assert(b.value.changedAt?.getTime() === a.value.changedAt.getTime(), "changedAt moved without a days change");
  });

  await test("settings: invalid values are rejected before saving", async () => {
    const snap = await getSettingsSnapshot("limits", { fresh: true });
    const bad = { plans: { free: { ...snap.value.plans.free, maxFileMB: 500 } } };
    await expectReject(
      updateSettings("limits", bad, { expectedVersion: snap.version, actor }),
      (e) => e instanceof AppError && e.code === "VALIDATION_FAILED",
      "maxFileMB 500",
    );
  });

  await test("audit: every settings save wrote an audit log entry", async () => {
    const n = await AuditLog.countDocuments({ action: "settings.update" });
    assert(n === 3, `expected 3 entries, found ${n}`);
  });

  // ── users ──
  const user = await User.create({ clerkId: "clerk_smoke_1", email: "  Smoke@Example.COM " });

  await test("users: email is lowercased/trimmed, defaults applied", async () => {
    const u = await User.findById(user._id).lean();
    assert(u?.email === "smoke@example.com", `email ${u?.email}`);
    assert(u?.role === "user" && u?.status === "active" && u?.plan === "free", "role/status/plan defaults");
    assert(u?.quota?.minutesUsed === 0, "quota default");
  });

  await test("users: duplicate clerkId is rejected (unique index)", async () => {
    await expectReject(User.create({ clerkId: "clerk_smoke_1", email: "other@example.com" }), isDup, "duplicate clerkId");
  });

  // ── videos: state machine, zombie guard, validators ──
  const video = await newVideo(user._id, { status: "queued", pipeline: { runId: "run-1" } });

  await test("videos: defaults — draft options, six pipeline stages all pending", async () => {
    const v = await Video.findById(video._id).lean();
    const stages = v?.pipeline?.stages;
    assert(stages && Object.values(stages).every((s) => s?.status === "pending"), "stages not all pending");
    assert(v?.options?.targetClipCount === 10 && v?.options?.aspectRatio === "9:16", "option defaults");
  });

  await test("videos: guarded transition queued → processing succeeds exactly once", async () => {
    const first = await Video.updateOne({ _id: video._id, status: "queued" }, { $set: { status: "processing" } });
    const second = await Video.updateOne({ _id: video._id, status: "queued" }, { $set: { status: "processing" } });
    assert(first.modifiedCount === 1, "first transition failed");
    assert(second.matchedCount === 0, "second transition should match nothing");
  });

  await test("videos: zombie guard — a write from an old run changes nothing", async () => {
    const res = await Video.updateOne(
      { _id: video._id, "pipeline.runId": "run-0" },
      { $set: { "pipeline.progress": 0.9 } },
    );
    assert(res.matchedCount === 0, "stale runId matched");
  });

  await test("videos: one stage updated by dot path, others untouched", async () => {
    await Video.updateOne(
      { _id: video._id, "pipeline.runId": "run-1" },
      { $set: { "pipeline.stages.transcribe.status": "done", "pipeline.stages.transcribe.progress": 1 } },
    );
    const v = await Video.findById(video._id).lean();
    assert(v?.pipeline?.stages?.transcribe?.status === "done", "transcribe not done");
    assert(v?.pipeline?.stages?.render?.status === "pending", "render changed");
  });

  await test("validators run on updates too (bad enum rejected by updateOne)", async () => {
    await expectReject(
      Video.updateOne({ _id: video._id }, { $set: { "pipeline.stages.audio.status": "bogus" as "done" } }),
      (e) => e instanceof mongoose.Error.ValidationError || e instanceof mongoose.Error.CastError || /enum|valid/i.test(String(e)),
      "bad stage status",
    );
  });

  await test("strictQuery 'throw': filtering on a non-existent field throws", async () => {
    await expectReject(Video.countDocuments({ notARealField: 1 } as never), () => true, "unknown filter field");
  });

  await test("videos: clientRequestId makes double-submits idempotent", async () => {
    await newVideo(user._id, { clientRequestId: "req-abc" });
    await expectReject(newVideo(user._id, { clientRequestId: "req-abc" }), isDup, "same clientRequestId");
    // Videos without a clientRequestId are unaffected by the partial unique index.
    await newVideo(user._id);
    await newVideo(user._id);
  });

  // ── clips: integer ms + Bangla text ──
  await test("clips: fractional milliseconds are rejected (create and update)", async () => {
    await expectReject(
      Clip.create({ videoId: video._id, userId: user._id, origin: "ai", startMs: 1000.5, endMs: 5000, durationMs: 4000 }),
      isValidation,
      "create with 1000.5 ms",
    );
    const ok = await Clip.create({ videoId: video._id, userId: user._id, origin: "ai", startMs: 1000, endMs: 5000, durationMs: 4000 });
    await expectReject(Clip.updateOne({ _id: ok._id }, { $set: { endMs: 5000.25 } }), () => true, "update with 5000.25 ms");
  });

  await test("text: Bangla is stored NFC and ZWJ is preserved", async () => {
    const decomposed = "সোনার".normalize("NFD"); // ো split into two code points
    const withZwj = "র‍্যাব";
    assert(decomposed !== "সোনার".normalize("NFC"), "test string isn't actually decomposed");
    const c = await Clip.create({
      videoId: video._id,
      userId: user._id,
      origin: "manual",
      startMs: 0,
      endMs: 20_000,
      durationMs: 20_000,
      transcriptText: `${decomposed} ${withZwj}`,
    });
    const stored = (await Clip.findById(c._id).lean())?.transcriptText ?? "";
    assert(stored.includes("ো"), "ো was not composed (NFC)");
    assert(stored.includes("‍"), "ZWJ was stripped");
  });

  // ── unique constraints that prevent duplicate work / double charging ──
  await test("transcripts: one row per (video, version)", async () => {
    const t = { videoId: video._id, userId: user._id, version: 1, kind: "asr", language: "bn", script: "Beng" } as const;
    await Transcript.create(t);
    await expectReject(Transcript.create(t), isDup, "duplicate version");
    await Transcript.create({ ...t, version: 2, kind: "user_edit", basedOnVersion: 1 });
  });

  await test("renders: identical spec for the same clip is stored once", async () => {
    const clipId = new Types.ObjectId();
    const r = {
      clipId,
      videoId: video._id,
      userId: user._id,
      specHash: "sha256:abc",
      spec: { startMs: 0, endMs: 30_000, aspectRatio: "9:16", width: 1080, height: 1920, captionStyleId: "preset:bold", captionScript: "Beng" },
    } as const;
    await Render.create(r);
    await expectReject(Render.create(r), isDup, "duplicate render");
  });

  await test("usage_events: a retried job can't charge twice", async () => {
    const e = { userId: user._id, type: "transcribe", quantity: 12, unit: "minutes", idempotencyKey: `video:${video._id}:run:run-1:transcribe` } as const;
    await UsageEvent.create(e);
    await expectReject(UsageEvent.create(e), isDup, "same idempotencyKey");
  });

  // ── retention rules (pure functions + the cleanup query) ──
  const now = new Date();
  const base: RetentionSettings = { plans: { free: { days: 7 } }, graceHours: 24, changedAt: null, purgeSoftDeletedAfterDays: 30 };

  await test("retention: expires finishedAt + plan days", () => {
    const v = { retention: { finishedAt: new Date(now.getTime() - 10 * DAY) } };
    assert(effectiveExpiry(v, "free", base)?.getTime() === now.getTime() - 3 * DAY, "wrong expiry");
    assert(isExpired(v, "free", base, now), "should be expired");
    assert(effectiveExpiry({ retention: {} }, "free", base) === null, "still-processing video should have no expiry");
  });

  await test("retention: admin change applies to OLD videos, with 24 h grace", () => {
    const old = { retention: { finishedAt: new Date(now.getTime() - 5 * DAY) } };
    const shortened: RetentionSettings = { ...base, plans: { free: { days: 3 } }, changedAt: now };
    assert(!isExpired(old, "free", shortened, now), "deleted instantly despite grace");
    assert(isExpired(old, "free", shortened, new Date(now.getTime() + 25 * HOUR)), "not expired after grace");
    assert(isExpired(old, "free", { ...shortened, graceHours: 0 }, now), "grace 0 should expire now");
    const lengthened: RetentionSettings = { ...base, plans: { free: { days: 30 } }, changedAt: now };
    assert(!isExpired({ retention: { finishedAt: new Date(now.getTime() - 10 * DAY) } }, "free", lengthened, now), "lengthening didn't extend");
  });

  await test("retention: admin per-video override wins; unknown plan falls back to free", () => {
    const override = { retention: { finishedAt: new Date(now.getTime() - 100 * DAY), expireOverrideAt: new Date(now.getTime() + DAY) } };
    assert(!isExpired(override, "free", base, now), "override ignored");
    assert(isExpired({ retention: { finishedAt: new Date(now.getTime() - 8 * DAY) } }, "gold", base, now), "unknown plan fallback");
  });

  await test("retention: cleanup candidate query runs and finds only due videos", async () => {
    await newVideo(user._id, { retention: { finishedAt: new Date(now.getTime() - 10 * DAY) } });
    await newVideo(user._id, { retention: { finishedAt: new Date(now.getTime() - 1 * DAY) } });
    await newVideo(user._id, { retention: { finishedAt: new Date(now.getTime() - 10 * DAY), assetsDeletedAt: now } });
    const n = await Video.countDocuments(expiryCandidatesFilter(base, now));
    assert(n === 1, `expected 1 candidate, got ${n}`);
  });

  // ── plan limits ──
  await test("limits: per-user override on top of plan; 100 MB hard cap always wins", () => {
    const limits = defaultSettings("limits");
    const l = effectivePlanLimits({ plan: "free", limitsOverride: { monthlyMinutes: 500, maxFileMB: 150 } }, limits);
    assert(l.monthlyMinutes === 500, "override not applied");
    assert(l.maxFileMB === 100, `hard cap not applied (${l.maxFileMB})`);
    assert(l.concurrentJobs === 1, "non-overridden value changed");
  });
}

async function cleanup() {
  const db = mongoose.connection.db;
  if (!db || db.databaseName !== TEST_DB) return; // never drop anything but the test database
  try {
    await db.dropDatabase();
  } catch {
    for (const c of await db.listCollections().toArray()) await db.dropCollection(c.name);
  }
}

main()
  .catch((err: unknown) => {
    results.push({ name: "test run", ok: false, detail: err instanceof Error ? err.message : String(err) });
  })
  .finally(async () => {
    await cleanup().catch((err) => console.error("cleanup failed:", err));
    await disconnectDb().catch(() => {});
    for (const r of results) {
      console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.detail ? `\n      → ${r.detail}` : ""}`);
    }
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n${passed}/${results.length} passed · test database "${TEST_DB}" dropped\n`);
    process.exitCode = passed === results.length ? 0 : 1;
  });
