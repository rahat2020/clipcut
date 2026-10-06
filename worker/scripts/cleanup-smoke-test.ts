/**
 * Proves the cleanup job (Step 17, D51): what it deletes, what it must never touch, and that a
 * failure is simply retried.
 *
 *   npm run cleanup:smoke
 *
 * Throwaway database <MONGODB_DB>_cleanuptest (dropped). Cloudinary is FAKED (an in-memory list
 * of files), so nothing real is read or deleted; the real Cloudinary calls are only exercised
 * by `npm run cleanup:run -- --dry`.
 */
import mongoose, { Types } from "mongoose";

import { env } from "../src/config/env";
import { runCleanup, type CleanupDeps } from "../src/cleanup/cleanup";
import { scheduledCleanup } from "../src/cleanup/schedule";
import { connectDb, disconnectDb } from "../src/lib/db";
import { logger } from "../src/lib/logger";
import { runShutdownHooks } from "../src/lib/shutdown";
import {
  AnalysisRun,
  Clip,
  clearSettingsCache,
  CLEANUP_TIMING,
  defaultSettings,
  getSettingsSnapshot,
  Render,
  Transcript,
  UsageEvent,
  updateSettings,
  User,
  Video,
} from "../src/shared";

logger.level = "silent";

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

const TEST_DB = `${env.MONGODB_DB}_cleanuptest`;
const actor = { email: "smoke-test@local", userId: null };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-10-10T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

/** The fake Cloudinary: which videos have files, who made them, and a switch to break it. */
const files = new Map<string, { userId: string; newestAt: Date }>();
const deletedLog: string[] = [];
let failFor: string | null = null;
let rateLimited = false;
const deps: CleanupDeps = {
  async deleteVideoFiles(userId, videoId) {
    if (rateLimited) throw Object.assign(new Error("rate limit"), { http_code: 420 });
    if (failFor === videoId) throw new Error("cloudinary is down");
    deletedLog.push(videoId);
    files.delete(videoId);
    void userId;
  },
  async listStoredVideos() {
    return [...files.entries()].map(([videoId, f]) => ({ videoId, userId: f.userId, newestAt: f.newestAt, files: 2 }));
  },
};
const addFiles = (videoId: Types.ObjectId | string, userId: Types.ObjectId, newestAt = ago(30 * DAY)) => files.set(String(videoId), { userId: String(userId), newestAt });

async function main() {
  console.log(`\nCleanup smoke test → db "${TEST_DB}" (dropped afterwards, Cloudinary faked)\n`);
  await connectDb({ dbName: TEST_DB, autoIndex: false });
  const db = mongoose.connection.db!;
  for (const c of await db.listCollections().toArray()) await db.dropCollection(c.name);
  clearSettingsCache();

  const user = await User.create({ clerkId: "user_cleanup", email: "cleanup@example.com" });
  const mkVideo = async (extra: Record<string, unknown> = {}) => {
    const v = await Video.create({
      userId: user._id,
      title: "Cleanup smoke test",
      language: "bn",
      source: { type: "upload", originalFilename: "t.mp4" },
      permission: { confirmedAt: ago(40 * DAY), termsVersion: "2026-09-28" },
      status: "ready",
      ...extra,
    });
    return v._id;
  };
  const load = (id: Types.ObjectId) => Video.findById(id).lean();
  const reset = () => {
    deletedLog.length = 0;
    failFor = null;
    rateLimited = false;
  };

  try {
    await test("expired: a finished video past its plan's days loses its files and is marked; fresh, re-processing and admin-extended ones are left alone; a second run does nothing", async () => {
      reset();
      const old = await mkVideo({ retention: { finishedAt: ago(8 * DAY) } });
      const fresh = await mkVideo({ retention: { finishedAt: ago(2 * DAY) } });
      const again = await mkVideo({ status: "processing", retention: { finishedAt: ago(10 * DAY) } }); // "Find new clips" running
      const extended = await mkVideo({ retention: { finishedAt: ago(10 * DAY), expireOverrideAt: new Date(NOW.getTime() + 3 * DAY) } });
      for (const id of [old, fresh, again, extended]) addFiles(id, user._id);

      const r = await runCleanup(deps, { now: NOW });
      assert(r.expired.join() === String(old) && deletedLog.join() === String(old), `expired ${r.expired}, deleted ${deletedLog}`);
      assert((await load(old))?.retention?.assetsDeletedAt && !(await load(fresh))?.retention?.assetsDeletedAt, "marks wrong");
      assert(!(await load(again))?.retention?.assetsDeletedAt && !(await load(extended))?.retention?.assetsDeletedAt, "touched a re-processing / extended video");
      assert((await load(old))?.status === "ready" && !(await load(old))?.deletedAt, "an archive must stay visible");

      reset();
      const second = await runCleanup(deps, { now: NOW });
      assert(second.expired.length === 0 && deletedLog.length === 0, "not idempotent");
    });

    await test("retention change: shortening the days never deletes before the grace period; after it, it does", async () => {
      reset();
      // 7 → 2 days: the settings service stamps `changedAt` with the real clock, so this test works in real time.
      await updateSettings("retention", { ...defaultSettings("retention"), plans: { free: { days: 2 } } }, { expectedVersion: 0, actor });
      clearSettingsCache();
      const snap = await getSettingsSnapshot("retention");
      const stamped = new Date(snap.value.changedAt ?? Date.now());
      // The video is 3 days old (older than the new 2 days) but the 24 h grace protects it.
      const v = await mkVideo({ retention: { finishedAt: new Date(stamped.getTime() - 3 * DAY) } });
      addFiles(v, user._id);

      const early = await runCleanup(deps, { now: new Date(stamped.getTime() + HOUR) });
      assert(early.expired.length === 0, `deleted ${early.expired} inside the grace period`);
      const late = await runCleanup(deps, { now: new Date(stamped.getTime() + 25 * HOUR) });
      assert(late.expired.join() === String(v), `after the grace: ${late.expired}`);
      // Back to 7 days for the tests that follow.
      await updateSettings("retention", { ...snap.value, plans: { free: { days: 7 } } }, { expectedVersion: snap.version, actor });
      clearSettingsCache();
    });

    await test("deleted by the user: files removed and marked; a failed delete is not marked and is retried (not counted as done)", async () => {
      reset();
      const v = await mkVideo({ deletedAt: ago(DAY) });
      addFiles(v, user._id);
      failFor = String(v);
      const bad = await runCleanup(deps, { now: NOW });
      assert(bad.failed === 1 && bad.deleted.length === 0 && !(await load(v))?.retention?.assetsDeletedAt, `failed ${bad.failed}, deleted ${bad.deleted}`);
      failFor = null;
      const good = await runCleanup(deps, { now: NOW });
      assert(good.deleted.join() === String(v) && (await load(v))?.retention?.assetsDeletedAt, "not retried");
    });

    await test("abandoned draft: older than 48 h → deleted with its files in the same run; a fresh draft stays", async () => {
      reset();
      const stale = await mkVideo({ status: "draft" });
      const fresh = await mkVideo({ status: "draft" });
      await Video.collection.updateOne({ _id: stale }, { $set: { createdAt: ago(3 * DAY) } });
      await Video.collection.updateOne({ _id: fresh }, { $set: { createdAt: ago(HOUR) } });
      addFiles(stale, user._id);
      addFiles(fresh, user._id, ago(HOUR));
      const r = await runCleanup(deps, { now: NOW });
      const s = await load(stale);
      assert(r.abandoned.join() === String(stale) && s?.deletedAt && s.retention?.assetsDeletedAt, `abandoned ${r.abandoned}`);
      const f = await load(fresh);
      assert(!f?.deletedAt && files.has(String(fresh)), "a draft that is still being uploaded was touched");
    });

    await test("purge: a video deleted > 30 days ago whose files are gone loses its documents (usage ledger stays); a recent one and one with files left stay", async () => {
      reset();
      const gone = await mkVideo({ deletedAt: ago(31 * DAY), retention: { assetsDeletedAt: ago(30 * DAY) } });
      const recent = await mkVideo({ deletedAt: ago(5 * DAY), retention: { assetsDeletedAt: ago(5 * DAY) } });
      const filesLeft = await mkVideo({ deletedAt: ago(40 * DAY) });
      failFor = String(filesLeft); // its files can't be removed, so it must not be purged either
      addFiles(filesLeft, user._id);
      for (const id of [gone, recent]) {
        await Clip.collection.insertOne({ videoId: id, userId: user._id });
        await Transcript.collection.insertOne({ videoId: id, userId: user._id });
        await AnalysisRun.collection.insertOne({ videoId: id, userId: user._id });
        await Render.collection.insertOne({ videoId: id, userId: user._id });
      }
      await UsageEvent.collection.insertOne({ userId: user._id, videoId: gone });

      const r = await runCleanup(deps, { now: NOW });
      assert(r.purged.join() === String(gone), `purged ${r.purged}`);
      assert(!(await load(gone)), "video document remains");
      const left = (await Clip.countDocuments({ videoId: gone })) + (await Transcript.countDocuments({ videoId: gone })) + (await AnalysisRun.countDocuments({ videoId: gone })) + (await Render.countDocuments({ videoId: gone }));
      assert(left === 0, `${left} related documents remain`);
      assert((await UsageEvent.countDocuments({ videoId: gone })) === 1, "the usage ledger must stay");
      assert((await load(recent)) && (await Clip.countDocuments({ videoId: recent })) === 1, "a recent deletion was purged");
      assert((await load(filesLeft)) && !(await load(filesLeft))?.retention?.assetsDeletedAt, "purged a video whose files are still there");
    });

    await test("orphans: files with no video, or a video marked 'files deleted', go; a live video's files, files under a day old, and anything past the per-scan limit stay", async () => {
      reset();
      files.clear();
      const live = await mkVideo({ retention: { finishedAt: ago(DAY) } });
      const marked = await mkVideo({ deletedAt: ago(DAY), retention: { assetsDeletedAt: ago(DAY) } });
      const noDoc = new Types.ObjectId();
      const recentNoDoc = new Types.ObjectId();
      addFiles(live, user._id);
      addFiles(marked, user._id);
      addFiles(noDoc, user._id);
      addFiles(recentNoDoc, user._id, ago(2 * HOUR));

      const dry = await runCleanup(deps, { now: NOW, orphans: true, dryRun: true });
      assert(dry.orphans.length === 2 && deletedLog.length === 0, `dry run: ${dry.orphans.length} found, ${deletedLog.length} deleted`);
      const r = await runCleanup(deps, { now: NOW, orphans: true });
      assert(r.orphans.sort().join() === [String(marked), String(noDoc)].sort().join(), `orphans ${r.orphans}`);
      assert(files.has(String(live)) && files.has(String(recentNoDoc)), "deleted a live or very recent video's files");

      files.clear();
      for (let i = 0; i < CLEANUP_TIMING.maxOrphanVideos + 5; i++) addFiles(new Types.ObjectId(), user._id);
      const many = await runCleanup(deps, { now: NOW, orphans: true });
      assert(many.orphans.length === CLEANUP_TIMING.maxOrphanVideos && many.moreOrphans === 5, `${many.orphans.length} deleted, ${many.moreOrphans} left`);
    });

    await test("rate limit: Cloudinary says slow down → the run stops, nothing is marked, no failure is counted, and a note says why", async () => {
      reset();
      files.clear();
      const v = await mkVideo({ deletedAt: ago(DAY) });
      addFiles(v, user._id);
      rateLimited = true;
      const r = await runCleanup(deps, { now: NOW });
      assert(r.deleted.length === 0 && r.failed === 0 && r.notes.length === 1 && !(await load(v))?.retention?.assetsDeletedAt, JSON.stringify(r));
      rateLimited = false;
      assert((await runCleanup(deps, { now: NOW })).deleted.join() === String(v), "not picked up next run");
    });

    await test("dry run changes nothing; kill switch (settings.system.cleanupEnabled = false) stops the scheduled job; an empty database never looks like 'all orphans'", async () => {
      reset();
      files.clear();
      const old = await mkVideo({ retention: { finishedAt: ago(30 * DAY) } });
      addFiles(old, user._id);
      const dry = await runCleanup(deps, { now: NOW, dryRun: true });
      assert(dry.expired.join() === String(old) && deletedLog.length === 0 && !(await load(old))?.retention?.assetsDeletedAt, "a dry run changed something");

      await updateSettings("system", { ...defaultSettings("system"), cleanupEnabled: false }, { expectedVersion: 0, actor });
      clearSettingsCache();
      assert((await scheduledCleanup({ orphans: true })) === null, "ran with the kill switch on");

      await Video.deleteMany({});
      addFiles(new Types.ObjectId(), user._id);
      const filesBefore = files.size;
      const empty = await runCleanup(deps, { now: NOW, orphans: true });
      assert(empty.orphans.length === 0 && empty.notes.some((n) => /no videos at all/.test(n)) && files.size === filesBefore, "scanned an empty database");
    });
  } finally {
    if (mongoose.connection.db?.databaseName === TEST_DB) await mongoose.connection.db.dropDatabase().catch(() => {});
    await disconnectDb().catch(() => {});
    await runShutdownHooks(() => {});
  }
}

main()
  .catch((err: unknown) => results.push({ name: "test run", ok: false, detail: err instanceof Error ? err.message : String(err) }))
  .finally(() => {
    for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.detail ? `\n      → ${r.detail}` : ""}`);
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n${passed}/${results.length} passed · test database removed\n`);
    process.exit(passed === results.length ? 0 : 1);
  });
