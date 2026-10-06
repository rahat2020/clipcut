/**
 * Checks the admin panel's services (docs/ADMIN.md) against a REAL MongoDB, Cloudinary and
 * the AI providers' model lists — every rule the pages and server actions rely on:
 * videos (list, retry, cancel, re-pick clips, delete), users (list, plan, limit override,
 * usage reset, suspend, admin role, delete all data) and the AI models page (save with
 * version check, prompt-version guard, live model lists, one Test request).
 *
 *   npm run admin:smoke
 *
 * Isolation: throwaway "<MONGODB_DB>_admintest" database (dropped); Cloudinary files under
 * "smoketest/" (removed). The Clerk delete is a fake that records the id. Uses 1 Gemini request.
 */
import { loadEnvConfig } from "@next/env";
import { v2 as cloudinary } from "cloudinary";
import mongoose, { Types } from "mongoose";
import { ZodError } from "zod";

import { listModels, saveAiSettings, testModel } from "../src/lib/admin/ai-service";
import { auditListQuerySchema, listAudit } from "../src/lib/admin/audit-service";
import {
  adminSetVideoExpiry,
  expiringSoon,
  previewRetention,
  saveLimits,
  saveRetention,
  saveSystem,
  usersPerPlan,
} from "../src/lib/admin/settings-service";
import { backupHealth, MONGO_LIMIT_BYTES, readCloudinaryUsage, readDatabaseInfo } from "../src/lib/admin/system-info";
import {
  deleteUserData,
  listUsersForAdmin,
  resetUserUsage,
  setUserLimitsOverride,
  setUserPlan,
  setUserRole,
  suspendUser,
  unsuspendUser,
  userListQuerySchema,
} from "../src/lib/admin/users-service";
import {
  adminCancelVideo,
  adminDeleteVideo,
  adminRerunClipSelection,
  adminRetryVideo,
  listVideosForAdmin,
  videoListQuerySchema,
} from "../src/lib/admin/videos-service";
import { formatEnvIssues, serverEnvSchema } from "../src/lib/env.schema";
import type { CloudinaryConfig } from "../src/lib/uploads/cloudinary-core";
import {
  AnalysisRun,
  AppError,
  AuditLog,
  Clip,
  configureMongoose,
  effectiveExpiry,
  effectivePlanLimits,
  getSettings,
  getSettingsSnapshot,
  isAppError,
  newRunId,
  Setting,
  Transcript,
  UsageEvent,
  updateSettings,
  User,
  Video,
} from "../src/shared";

loadEnvConfig(process.cwd());

const results: { name: string; ok: boolean; detail?: string }[] = [];
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
  }
}
function expect(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
async function codeOf(fn: () => unknown): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    if (isAppError(err)) return err.code;
    if (err instanceof ZodError) return "ZodError";
    return `non-AppError: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function main() {
  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error(`web/.env.local is incomplete:\n${formatEnvIssues(parsed.error).join("\n")}`);
    process.exit(1);
  }
  const env = parsed.data;
  const cfg: CloudinaryConfig = {
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    apiKey: env.CLOUDINARY_API_KEY,
    apiSecret: env.CLOUDINARY_API_SECRET,
    baseFolder: "smoketest",
  };
  cloudinary.config({ cloud_name: cfg.cloudName, api_key: cfg.apiKey, api_secret: cfg.apiSecret, secure: true });
  const dbName = `${env.MONGODB_DB}_admintest`;

  configureMongoose();
  await mongoose.connect(env.MONGODB_URI, { dbName, serverSelectionTimeoutMS: 15_000 });
  console.log(`\nAdmin smoke test · database "${dbName}" · Cloudinary folder "${cfg.baseFolder}/"\n`);

  try {
    await mongoose.connection.dropDatabase();
    for (const M of [User, Video, Transcript, AnalysisRun, Clip, UsageEvent, AuditLog, Setting]) await M.createIndexes();

    const owner = await User.create({ clerkId: "user_owner", email: "owner@example.com", role: "admin" });
    const helper = await User.create({ clerkId: "user_helper", email: "helper@example.com", role: "admin" });
    const alice = await User.create({ clerkId: "user_alice", email: "alice@example.com", quota: { periodStart: new Date(), minutesUsed: 7 } });
    const bob = await User.create({ clerkId: "user_bob", email: "bob@example.com", quota: { periodStart: new Date(), minutesUsed: 30 } });
    const actor = { userId: helper._id, email: helper.email };
    const ctx = { actor, adminEmails: ["owner@example.com"] };
    const audits = (action: string, id: Types.ObjectId) => AuditLog.countDocuments({ action, "target.id": String(id) });

    const DONE = { status: "done" as const, progress: 1 };
    const mkVideo = (userId: Types.ObjectId, title: string, extra: Record<string, unknown> = {}) =>
      Video.create({
        userId,
        title,
        language: "bn",
        source: { type: "youtube", externalId: "abcdefghijk" },
        permission: { confirmedAt: new Date(), termsVersion: "2026-09-28" },
        status: "failed",
        pipeline: { runId: newRunId(), stages: { ingest: DONE, audio: DONE, transcribe: DONE, analyze: { status: "failed" } } },
        error: { code: "AI_UNAVAILABLE", message: "busy", stage: "analyze", retryable: true, at: new Date() },
        ...extra,
      });

    // ── videos ──────────────────────────────────────────────

    const failed = await mkVideo(alice._id, "Football highlights");
    const processing = await mkVideo(bob._id, "Bangla podcast", { status: "processing", error: undefined });
    const gone = await mkVideo(bob._id, "Old deleted one", { deletedAt: new Date() });

    await test("videos list: status filter, title or owner-email search, deleted hidden unless asked", async () => {
      const q = (o: Record<string, string>) => listVideosForAdmin(videoListQuerySchema.parse(o));
      expect((await q({ status: "failed" })).rows.map((r) => r.title).join() === "Football highlights", "status filter");
      expect((await q({ q: "podcast" })).rows[0]?.title === "Bangla podcast", "title search");
      const byEmail = await q({ q: "bob@" });
      expect(byEmail.total === 1 && byEmail.rows[0]?.user?.email === "bob@example.com", `email search ${byEmail.total}`);
      expect((await q({ deleted: "only" })).rows[0]?.id === String(gone._id), "deleted only");
      expect((await q({ status: "nonsense", page: "x" })).total === 2, "bad filters should be ignored");
    });

    await test("retry: failed → queued, new run, done stages kept, others reset; audited", async () => {
      const before = await Video.findById(failed._id).lean().orFail();
      await adminRetryVideo(actor, String(failed._id));
      const v = await Video.findById(failed._id).lean().orFail();
      expect(v.status === "queued" && !v.error && v.pipeline?.runId !== before.pipeline?.runId, `status ${v.status}`);
      expect(v.pipeline?.stages?.transcribe?.status === "done" && v.pipeline?.stages?.analyze?.status === "pending", "stages");
      expect((await audits("video.retry", failed._id)) === 1, "no audit entry");
    });

    await test("cancel: queued/processing → canceled; a finished one → CONFLICT; canceled can be retried by admin", async () => {
      await adminCancelVideo(actor, String(processing._id));
      const v = await Video.findById(processing._id).lean().orFail();
      expect(v.status === "canceled" && v.retention?.finishedAt, `status ${v.status}`);
      expect((await codeOf(() => adminCancelVideo(actor, String(processing._id)))) === "CONFLICT", "canceled twice");
      await adminRetryVideo(actor, String(processing._id));
      expect((await Video.findById(processing._id).lean())?.status === "queued", "canceled not retried");
      expect((await codeOf(() => adminRetryVideo(actor, String(processing._id)))) === "CONFLICT", "queued retried");
      expect((await codeOf(() => adminRetryVideo(actor, String(gone._id)))) === "NOT_FOUND", "deleted video retried");
    });

    await test("re-pick clips: queued with analyzeWith, analyze/copy/render reset, transcript kept; guards", async () => {
      const t = await Transcript.create({ videoId: failed._id, userId: alice._id, version: 1, kind: "asr", language: "bn", script: "Beng", segments: [] });
      await Video.updateOne({ _id: failed._id }, { $set: { status: "failed", currentTranscriptId: t._id } });
      const choice = { provider: "groq" as const, model: "openai/gpt-oss-120b", promptVersion: "clip-select@1" };
      await adminRerunClipSelection(actor, String(failed._id), choice);
      const v = await Video.findById(failed._id).lean().orFail();
      expect(v.status === "queued" && v.pipeline?.analyzeWith?.model === "openai/gpt-oss-120b" && v.pipeline.analyzeWith.requestedBy === actor.email, "analyzeWith");
      expect(v.pipeline?.stages?.transcribe?.status === "done" && v.pipeline?.stages?.analyze?.status === "pending", "stages");
      expect((await codeOf(() => adminRerunClipSelection(actor, String(failed._id), choice))) === "CONFLICT", "re-pick while queued");
      await Video.updateOne({ _id: failed._id }, { $set: { status: "failed" } });
      expect((await codeOf(() => adminRerunClipSelection(actor, String(failed._id), { ...choice, promptVersion: "clip-select@99" }))) === "ZodError", "unknown prompt");
      const noTranscript = await mkVideo(alice._id, "Stopped early");
      await Video.updateOne({ _id: noTranscript._id }, { $set: { "pipeline.stages.transcribe.status": "failed" } });
      expect((await codeOf(() => adminRerunClipSelection(actor, String(noTranscript._id), choice))) === "CONFLICT", "no transcript");
      expect((await audits("video.clips.rerun", failed._id)) === 1, "no audit entry");
    });

    await test("delete: another user's video is soft-deleted for its owner; audited", async () => {
      const v = await mkVideo(bob._id, "To delete");
      await adminDeleteVideo({ cfg, actor }, String(v._id));
      const after = await Video.findById(v._id).lean().orFail();
      expect(after.deletedAt, "not deleted");
      expect((await audits("video.delete", v._id)) === 1, "no audit entry");
    });

    // ── users ───────────────────────────────────────────────

    await updateSettings(
      "limits",
      { plans: { free: {}, pro: { monthlyMinutes: 600 } } },
      { expectedVersion: (await getSettingsSnapshot("limits", { fresh: true })).version, actor },
    );

    await test("users list: search, status filter, sort by usage, minutes and video counts", async () => {
      const q = (o: Record<string, string>) => listUsersForAdmin(userListQuerySchema.parse(o));
      expect((await q({ q: "alice" })).rows[0]?.email === "alice@example.com", "search");
      const byUsage = await q({ sort: "usage" });
      expect(byUsage.rows[0]?.email === "bob@example.com" && byUsage.rows[0].minutesUsed === 30, "usage sort");
      const aliceRow = (await q({ q: "alice" })).rows[0]!;
      expect(aliceRow.videos === 2 && aliceRow.monthlyMinutes === 60, `alice row ${JSON.stringify(aliceRow)}`);
      expect((await q({ role: "admin" })).total === 2, "role filter");
    });

    await test("plan: change to an existing plan; unknown plan refused; audited with before/after", async () => {
      await setUserPlan(ctx, String(alice._id), "pro");
      expect((await User.findById(alice._id).lean())?.plan === "pro", "plan not changed");
      expect((await codeOf(() => setUserPlan(ctx, String(alice._id), "gold"))) === "VALIDATION_FAILED", "unknown plan");
      const a = await AuditLog.findOne({ action: "user.plan", "target.id": String(alice._id) }).lean();
      expect((a?.diff?.before as { plan?: string })?.plan === "free" && (a?.diff?.after as { plan?: string })?.plan === "pro", "audit diff");
    });

    await test("limit override: set → effective limits change; all blank → removed; out of range refused", async () => {
      await setUserLimitsOverride(ctx, String(alice._id), { monthlyMinutes: 900, allowYoutube: false, maxFileMB: null });
      let u = (await User.findById(alice._id).lean())!;
      const eff = effectivePlanLimits(u, await getSettings("limits"));
      expect(eff.monthlyMinutes === 900 && eff.allowYoutube === false && eff.maxFileMB === 100, JSON.stringify(eff));
      await setUserLimitsOverride(ctx, String(alice._id), { monthlyMinutes: null, allowYoutube: null });
      u = (await User.findById(alice._id).lean())!;
      expect(!u.limitsOverride, `override kept: ${JSON.stringify(u.limitsOverride)}`);
      expect((await codeOf(() => setUserLimitsOverride(ctx, String(alice._id), { maxFileMB: 500 }))) === "ZodError", "500 MB accepted");
    });

    await test("reset usage: minutes back to 0, period dates kept", async () => {
      const before = (await User.findById(bob._id).lean())!;
      await resetUserUsage(ctx, String(bob._id));
      const after = (await User.findById(bob._id).lean())!;
      expect(after.quota?.minutesUsed === 0 && after.quota.periodStart?.getTime() === before.quota?.periodStart?.getTime(), "quota");
    });

    await test("suspend: needs a reason; not yourself, not an owner; unsuspend restores", async () => {
      expect((await codeOf(() => suspendUser(ctx, String(bob._id), { reason: "" }))) === "ZodError", "empty reason");
      expect((await codeOf(() => suspendUser(ctx, String(helper._id), { reason: "testing" }))) === "FORBIDDEN", "suspended self");
      expect((await codeOf(() => suspendUser(ctx, String(owner._id), { reason: "testing" }))) === "FORBIDDEN", "suspended owner");
      await suspendUser(ctx, String(bob._id), { reason: "Spam uploads" });
      let b = (await User.findById(bob._id).lean())!;
      expect(b.status === "suspended" && b.suspension?.reason === "Spam uploads" && b.suspension.byUserId?.equals(helper._id), "suspension");
      expect((await codeOf(() => suspendUser(ctx, String(bob._id), { reason: "again" }))) === "CONFLICT", "suspended twice");
      await unsuspendUser(ctx, String(bob._id));
      b = (await User.findById(bob._id).lean())!;
      expect(b.status === "active" && !b.suspension, "unsuspend");
    });

    await test("admin role: grant and revoke; not your own; an owner can't be demoted", async () => {
      await setUserRole(ctx, String(alice._id), "admin");
      expect((await User.findById(alice._id).lean())?.role === "admin", "grant");
      await setUserRole(ctx, String(alice._id), "user");
      expect((await User.findById(alice._id).lean())?.role === "user", "revoke");
      expect((await codeOf(() => setUserRole(ctx, String(helper._id), "user"))) === "FORBIDDEN", "demoted self");
      expect((await codeOf(() => setUserRole(ctx, String(owner._id), "user"))) === "FORBIDDEN", "demoted owner");
      expect((await audits("user.admin.grant", alice._id)) === 1 && (await audits("user.admin.revoke", alice._id)) === 1, "audit");
    });

    await test("delete user data: typed email required; everything gone, account blocked + anonymised, Clerk called, ledger kept", async () => {
      const v = await mkVideo(bob._id, "Bob's clip video");
      const t = await Transcript.create({ videoId: v._id, userId: bob._id, version: 1, kind: "asr", language: "bn", script: "Beng", segments: [] });
      const run = await AnalysisRun.create({
        videoId: v._id,
        userId: bob._id,
        transcriptId: t._id,
        kind: "initial",
        input: { intent: "best", targetClipCount: 3, minClipMs: 15_000, maxClipMs: 60_000 },
        ai: { provider: "gemini", model: "m", promptVersion: "clip-select@1" },
        status: "done",
      });
      await Clip.create({ videoId: v._id, userId: bob._id, analysisRunId: run._id, origin: "ai", startMs: 0, endMs: 20_000, durationMs: 20_000 });
      await UsageEvent.create({ userId: bob._id, videoId: v._id, type: "transcribe", quantity: 3, unit: "minutes", idempotencyKey: `video:${String(v._id)}:transcribe` });
      const rawId = `smoketest/transcripts/${String(bob._id)}/${String(v._id)}/v1-words.json`;
      await cloudinary.uploader.upload(`data:application/json;base64,${Buffer.from("{}").toString("base64")}`, {
        resource_type: "raw",
        type: "authenticated",
        public_id: rawId,
      });

      const clerkCalls: string[] = [];
      const dctx = { ...ctx, cfg, deleteClerkUser: async (id: string) => void clerkCalls.push(id) };
      expect((await codeOf(() => deleteUserData(dctx, String(bob._id), "wrong@example.com"))) === "VALIDATION_FAILED", "wrong email accepted");
      expect((await codeOf(() => deleteUserData(dctx, String(owner._id), "owner@example.com"))) === "FORBIDDEN", "owner deleted");

      const result = await deleteUserData(dctx, String(bob._id), "BOB@example.com");
      expect(result.filesDeleted && result.clerkDeleted && clerkCalls.join() === "user_bob", JSON.stringify(result));
      const b = (await User.findById(bob._id).lean())!;
      expect(b.status === "suspended" && b.deletedAt && b.email.endsWith("@deleted.invalid") && !b.name, `user ${JSON.stringify({ s: b.status, e: b.email })}`);
      for (const [label, n] of [
        ["videos", await Video.countDocuments({ userId: bob._id })],
        ["transcripts", await Transcript.countDocuments({ userId: bob._id })],
        ["runs", await AnalysisRun.countDocuments({ userId: bob._id })],
        ["clips", await Clip.countDocuments({ userId: bob._id })],
      ] as const) {
        expect(n === 0, `${label} left: ${n}`);
      }
      expect((await UsageEvent.countDocuments({ userId: bob._id })) === 1, "ledger removed");
      const file = await cloudinary.api.resource(rawId, { resource_type: "raw", type: "authenticated" }).catch(() => null);
      expect(file === null, "Cloudinary file still there");
      expect((await codeOf(() => setUserPlan(ctx, String(bob._id), "pro"))) === "NOT_FOUND", "deleted user still editable");
    });

    // ── AI models page ──────────────────────────────────────

    await test("AI settings: save bumps the version + audits; unknown prompt and stale version refused", async () => {
      const snap = await getSettingsSnapshot("ai", { fresh: true });
      const next = { ...snap.value, clipSelection: { ...snap.value.clipSelection, temperature: 0.4 } };
      const saved = await saveAiSettings(actor, next, snap.version);
      expect(saved.version === snap.version + 1 && saved.value.clipSelection.temperature === 0.4, `version ${saved.version}`);
      expect((await AuditLog.countDocuments({ action: "settings.update", "target.id": "ai" })) === 1, "audit");
      const bad = { ...next, clipSelection: { ...next.clipSelection, promptVersion: "clip-select@99" } };
      expect((await codeOf(() => saveAiSettings(actor, bad, saved.version))) === "VALIDATION_FAILED", "unknown prompt saved");
      expect((await codeOf(() => saveAiSettings(actor, next, snap.version))) === "SETTINGS_CONFLICT", "stale version saved");
    });

    await test("AI models: no key → clear reason; live lists (Gemini text, Groq Whisper); one real Test", async () => {
      const none = await listModels("gemini", "text", {});
      expect(!none.ok && /GEMINI_API_KEY/.test(none.reason), "missing-key reason");
      const keys = { gemini: env.GEMINI_API_KEY, groq: env.GROQ_API_KEY };
      if (!keys.gemini || !keys.groq) throw new Error("GEMINI_API_KEY / GROQ_API_KEY not in web/.env.local — can't check the live lists");
      const gem = await listModels("gemini", "text", keys);
      expect(gem.ok && gem.models.includes("gemini-2.5-flash") && !gem.models.some((m) => /tts|image/.test(m)), `gemini ${JSON.stringify(gem).slice(0, 200)}`);
      const whisper = await listModels("groq", "transcription", keys);
      expect(whisper.ok && whisper.models.includes("whisper-large-v3"), `whisper ${JSON.stringify(whisper).slice(0, 200)}`);
      const t = await testModel("gemini", "gemini-2.5-flash", "text", keys);
      expect(t.ok, `test: ${t.message}`);
      const bogus = await testModel("gemini", "gemini-does-not-exist", "text", keys);
      expect(!bogus.ok && /404/.test(bogus.message), `bogus model: ${bogus.message}`);
    });

    // ── limits & plans (Step 16) ────────────────────────────

    await test("limits: save bumps the version + audits; stale version, bad plan name, out-of-range refused", async () => {
      const snap = await getSettingsSnapshot("limits", { fresh: true });
      const next = { plans: { ...snap.value.plans, free: { ...snap.value.plans.free!, monthlyMinutes: 90 } } };
      const auditsBefore = await AuditLog.countDocuments({ action: "settings.update", "target.id": "limits" });
      const saved = await saveLimits(actor, next, snap.version);
      expect(saved.version === snap.version + 1 && saved.value.plans.free?.monthlyMinutes === 90, `version ${saved.version}`);
      expect((await AuditLog.countDocuments({ action: "settings.update", "target.id": "limits" })) === auditsBefore + 1, "audit");
      expect((await codeOf(() => saveLimits(actor, next, snap.version))) === "SETTINGS_CONFLICT", "stale version saved");
      const badName = { plans: { ...next.plans, "Bad Name!": next.plans.free } };
      expect((await codeOf(() => saveLimits(actor, badName, saved.version))) === "VALIDATION_FAILED", "bad plan name saved");
      const tooBig = { plans: { ...next.plans, free: { ...next.plans.free, maxFileMB: 500 } } };
      expect((await codeOf(() => saveLimits(actor, tooBig, saved.version))) === "VALIDATION_FAILED", "file size over the 100 MB cap saved");
      expect((await getSettingsSnapshot("limits", { fresh: true })).value.plans.free?.maxFileMB === 100, "a refused save changed something");
    });

    await test("limits: a plan with users on it can't be removed, an empty one can; the default plan always stays", async () => {
      const snap = await getSettingsSnapshot("limits", { fresh: true });
      const withTeam = { plans: { ...snap.value.plans, team: { ...snap.value.plans.free!, monthlyMinutes: 600 } } };
      const v2 = await saveLimits(actor, withTeam, snap.version);
      expect(v2.value.plans.team?.monthlyMinutes === 600, "new plan not saved");
      await User.create({ clerkId: "user_erin", email: "erin@example.com", plan: "team" });
      const counts = await usersPerPlan();
      expect(counts.team === 1 && (counts.free ?? 0) >= 3, `counts ${JSON.stringify(counts)}`);
      const withoutTeam = { plans: Object.fromEntries(Object.entries(v2.value.plans).filter(([p]) => p !== "team")) };
      expect((await codeOf(() => saveLimits(actor, withoutTeam, v2.version))) === "VALIDATION_FAILED", "removed a plan that has users");
      await User.updateOne({ clerkId: "user_erin" }, { $set: { plan: "free" } });
      const v3 = await saveLimits(actor, withoutTeam, v2.version);
      expect(!("team" in v3.value.plans), "empty plan not removed");
      expect((await codeOf(() => saveLimits(actor, { plans: {} }, v3.version))) === "VALIDATION_FAILED", "saved without the default plan");
    });

    // ── retention (Step 16) ─────────────────────────────────

    const ago = (days: number) => new Date(Date.now() - days * 86_400_000);
    const kept = (userId: Types.ObjectId, title: string, finishedDaysAgo: number, extra: Record<string, unknown> = {}) =>
      mkVideo(userId, title, { status: "ready", error: undefined, retention: { finishedAt: ago(finishedDaysAgo) }, ...extra });
    const vB = await kept(alice._id, "Retention B (3 days old)", 3);
    await kept(alice._id, "Retention C (10 days old)", 10);
    await kept(bob._id, "Retention D (1 day old)", 1);
    await kept(alice._id, "Excluded: files already deleted", 3, { retention: { finishedAt: ago(3), assetsDeletedAt: new Date() } });
    await kept(alice._id, "Excluded: custom date", 3, { retention: { finishedAt: ago(3), expireOverrideAt: ago(-60) } });
    await kept(alice._id, "Excluded: deleted by the user", 3, { deletedAt: ago(10) });
    const retention2 = { plans: { free: { days: 2 } }, graceHours: 24, purgeSoftDeletedAfterDays: 30 };

    await test("retention preview: counts videos that go sooner / later, only those with files and no custom date; grace keeps overdue ones for a day", async () => {
      const now = new Date();
      const p = await previewRetention(retention2, now);
      const i = p.impact;
      expect(i.videos === 3, `videos ${i.videos}`);
      expect(i.shortened === 2 && i.lengthened === 1 && i.changed === 3, `shortened ${i.shortened} lengthened ${i.lengthened}`);
      expect(i.usersAffected === 2 && i.dueAtOnce === 0, `users ${i.usersAffected} dueAtOnce ${i.dueAtOnce}`);
      expect(i.earliest && Math.abs(i.earliest.getTime() - (now.getTime() + 86_400_000)) < 1000, `earliest ${i.earliest?.toISOString()}`);
      expect(p.confirm === "2", `confirm ${p.confirm}`);
      expect(p.graceUntil && Math.abs(p.graceUntil.getTime() - (now.getTime() + 86_400_000)) < 1000, "grace end");
      const noGrace = await previewRetention({ ...retention2, graceHours: 0 }, now);
      // Without grace the 3-day-old video is past the new deadline (deleted at the next run); the 10-day-old one was
      // already overdue and stays due — not "kept longer".
      expect(noGrace.impact.shortened === 2 && noGrace.impact.dueAtOnce === 1 && noGrace.impact.lengthened === 0 && noGrace.graceUntil === null, `no grace: ${JSON.stringify(noGrace.impact)}`);
      const same = await previewRetention({ plans: { free: { days: 7 } }, graceHours: 24, purgeSoftDeletedAfterDays: 30 }, now);
      expect(same.impact.changed === 0 && same.confirm === null, "an unchanged value should change nothing");
      expect((await codeOf(() => previewRetention({ plans: { free: { days: 0 } } }, now))) === "VALIDATION_FAILED", "days 0 accepted");
      expect((await getSettingsSnapshot("retention", { fresh: true })).version === 0, "a preview saved something");
    });

    await test("retention save: deleting sooner needs the new value typed (checked on the server); lengthening doesn't; changedAt stamped; audited", async () => {
      expect((await codeOf(() => saveRetention(actor, retention2, 0, ""))) === "VALIDATION_FAILED", "saved without confirming");
      expect((await codeOf(() => saveRetention(actor, retention2, 0, "3"))) === "VALIDATION_FAILED", "saved with the wrong confirmation");
      expect((await getSettingsSnapshot("retention", { fresh: true })).version === 0, "a refused save changed something");
      const saved = await saveRetention(actor, retention2, 0, " 2 ");
      expect(saved.version === 1 && saved.value.plans.free?.days === 2 && saved.value.changedAt instanceof Date, `saved ${JSON.stringify(saved.value)}`);
      expect((await AuditLog.countDocuments({ action: "settings.update", "target.id": "retention" })) === 1, "audit");
      expect((await codeOf(() => saveRetention(actor, retention2, 0, "2"))) === "SETTINGS_CONFLICT", "stale version saved");
      const longer = await saveRetention(actor, { ...retention2, plans: { free: { days: 14 } } }, saved.version, "");
      expect(longer.value.plans.free?.days === 14, "lengthening needed a confirmation");
    });

    await test("retention: shortening 'purge deleted records after' is confirmed only when it removes records at once", async () => {
      await Video.updateOne({ title: "Excluded: deleted by the user" }, { $set: { deletedAt: ago(10) } });
      const snap = await getSettingsSnapshot("retention", { fresh: true });
      const base = { plans: snap.value.plans, graceHours: snap.value.graceHours };
      const shorter = await previewRetention({ ...base, purgeSoftDeletedAfterDays: 5 });
      expect(shorter.purgeDue >= 1 && shorter.confirm === "5", `purgeDue ${shorter.purgeDue} confirm ${shorter.confirm}`);
      const longer = await previewRetention({ ...base, purgeSoftDeletedAfterDays: 60 });
      expect(longer.purgeDue === 0 && longer.confirm === null, "lengthening the purge delay needs no confirmation");
    });

    await test("expiring soon: lists videos due in the window (overdue ones too), not the ones with a custom date or deleted files", async () => {
      const snap = await getSettingsSnapshot("retention", { fresh: true });
      await saveRetention(actor, { plans: { free: { days: 2 } }, graceHours: snap.value.graceHours, purgeSoftDeletedAfterDays: snap.value.purgeSoftDeletedAfterDays }, snap.version, "2");
      const soon = await expiringSoon(24, 50);
      const titles = soon.rows.map((r) => r.title);
      expect(titles.some((t) => t.startsWith("Retention B")) && titles.some((t) => t.startsWith("Retention C")) && titles.some((t) => t.startsWith("Retention D")), `rows ${titles.join(" | ")}`);
      expect(!titles.some((t) => t.startsWith("Excluded")), `excluded video listed: ${titles.join(" | ")}`);
      expect(soon.total === soon.rows.length && soon.rows.every((r, k, all) => k === 0 || all[k - 1]!.expiresAt <= r.expiresAt), "not sorted soonest first");
    });

    await test("per-video expiry: keep N more days → custom date used by the retention rule; clear → plan's rule; bad days and deleted files refused; audited", async () => {
      const retention = await getSettings("retention");
      const base = effectiveExpiry((await Video.findById(vB._id).lean().orFail()), "free", retention)!;
      await adminSetVideoExpiry(actor, String(vB._id), 30);
      const after = await Video.findById(vB._id).lean().orFail();
      const want = Date.now() + 30 * 86_400_000;
      expect(after.retention?.expireOverrideAt && Math.abs(after.retention.expireOverrideAt.getTime() - want) < 5000, "override date");
      expect(effectiveExpiry(after, "free", retention)!.getTime() === after.retention!.expireOverrideAt!.getTime(), "override not used");
      expect(after.retention?.finishedAt?.getTime() === vB.retention?.finishedAt?.getTime(), "finishedAt changed");
      await adminSetVideoExpiry(actor, String(vB._id), null);
      const cleared = await Video.findById(vB._id).lean().orFail();
      expect(!cleared.retention?.expireOverrideAt && effectiveExpiry(cleared, "free", retention)!.getTime() === base.getTime(), "clear didn't restore the plan's rule");
      expect((await AuditLog.countDocuments({ action: "video.expiry", "target.id": String(vB._id) })) === 2, "audit");
      for (const days of [0, 400, 1.5]) expect((await codeOf(() => adminSetVideoExpiry(actor, String(vB._id), days))) === "ZodError", `days ${days} accepted`);
      expect((await codeOf(() => adminSetVideoExpiry(actor, String(new Types.ObjectId()), 5))) === "NOT_FOUND", "unknown video");
      const gone = await Video.findOne({ title: "Excluded: files already deleted" }).lean().orFail();
      expect((await codeOf(() => adminSetVideoExpiry(actor, String(gone._id), 5))) === "VALIDATION_FAILED", "extended deleted files");
    });

    // ── system, dashboard, audit log (Step 16) ──────────────

    await test("system: save bumps the version + audits; out-of-range, stale version refused; a refused save changes nothing", async () => {
      const snap = await getSettingsSnapshot("system", { fresh: true });
      const next = { ...snap.value, maintenanceMode: true, maintenanceMessage: "Back at noon", cleanupEnabled: false };
      const saved = await saveSystem(actor, next, snap.version);
      expect(saved.version === snap.version + 1 && saved.value.maintenanceMode && !saved.value.cleanupEnabled, `saved ${JSON.stringify(saved.value).slice(0, 120)}`);
      expect((await AuditLog.countDocuments({ action: "settings.update", "target.id": "system" })) === 1, "audit");
      expect((await codeOf(() => saveSystem(actor, { ...next, workerConcurrency: 9 }, saved.version))) === "VALIDATION_FAILED", "concurrency 9 accepted");
      expect((await codeOf(() => saveSystem(actor, { ...next, render: { ...next.render, preset: "slowest" } }, saved.version))) === "VALIDATION_FAILED", "unknown preset accepted");
      expect((await codeOf(() => saveSystem(actor, next, snap.version))) === "SETTINGS_CONFLICT", "stale version saved");
      expect((await getSettingsSnapshot("system", { fresh: true })).value.workerConcurrency === snap.value.workerConcurrency, "a refused save changed something");
      await saveSystem(actor, snap.value, saved.version); // back to normal
    });

    await test("database facts: size, collections with documents and indexes, migration status (read-only)", async () => {
      const info = await readDatabaseInfo({ collections: true });
      expect(info.name === dbName && info.usedBytes > 0 && info.usedBytes < MONGO_LIMIT_BYTES, `size ${info.usedBytes}`);
      const users = info.collections.find((c) => c.name === "users");
      expect(users && users.docs >= 4 && users.indexes >= 2, `users ${JSON.stringify(users)}`);
      expect(info.migrations.pending.length >= 1 && info.migrations.applied.length === 0 && info.migrations.unknown.length === 0, `migrations ${JSON.stringify(info.migrations)}`);
      expect((await readDatabaseInfo()).collections.length === 0, "collection list asked for when not wanted");
    });

    await test("backup health: off, Redis down, none yet, failed, old, fine", async () => {
      const now = new Date("2026-10-07T12:00:00Z");
      const at = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
      const ok = { at: at(5), bytes: 20_480, docs: 87, file: "x.gz" };
      expect(backupHealth({ reachable: true, last: ok, enabled: false }, now).tone === "warn", "off");
      expect(backupHealth({ reachable: false, last: null, enabled: true }, now).tone === "muted", "redis down");
      expect(backupHealth({ reachable: true, last: null, enabled: true }, now).headline === "No backup yet", "none");
      const failedB = backupHealth({ reachable: true, last: { at: at(1), error: "disk full" }, enabled: true }, now);
      expect(failedB.tone === "danger" && /disk full/.test(failedB.detail ?? ""), "failed");
      expect(backupHealth({ reachable: true, last: { ...ok, at: at(40) }, enabled: true }, now).tone === "warn", "old");
      const fine = backupHealth({ reachable: true, last: ok, enabled: true }, now);
      expect(fine.tone === "ok" && /5 hours ago/.test(fine.headline) && /87 documents/.test(fine.detail ?? ""), `fine ${JSON.stringify(fine)}`);
    });

    await test("Cloudinary credits: the real usage API answers with used / limit", async () => {
      const u = await readCloudinaryUsage(cfg);
      expect(u.ok && u.limit > 0 && u.used >= 0, `usage ${JSON.stringify(u)}`);
    });

    await test("audit log: filter by admin, action or group, record type and id; newest first; the change is included", async () => {
      const all = await listAudit(auditListQuerySchema.parse({}));
      expect(all.total >= 8 && all.rows.every((r, k, a) => k === 0 || a[k - 1]!.at >= r.at), "newest first");
      const settingsOnly = await listAudit(auditListQuerySchema.parse({ action: "settings.update" }));
      expect(settingsOnly.total >= 4 && settingsOnly.rows.every((r) => r.action === "settings.update"), "action filter");
      const group = await listAudit(auditListQuerySchema.parse({ action: "video." }));
      expect(group.total >= 4 && group.rows.every((r) => r.action.startsWith("video.")), `group ${group.total}`);
      const one = await listAudit(auditListQuerySchema.parse({ target: "video", id: String(vB._id) }));
      expect(one.total === 2 && one.rows.every((r) => r.target.id === String(vB._id)), "record filter");
      expect((await listAudit(auditListQuerySchema.parse({ who: "HELPER@" }))).total === all.total, "email search is case-insensitive");
      expect((await listAudit(auditListQuerySchema.parse({ who: "nobody" }))).total === 0, "email filter");
      expect((await listAudit(auditListQuerySchema.parse({ who: ".*" }))).total === 0, "regex characters must be literal");
      const limits = (await listAudit(auditListQuerySchema.parse({ target: "settings", id: "limits" }))).rows[0];
      expect(limits?.diff && /monthlyMinutes/.test(limits.diff) && /"before"/.test(limits.diff), "diff missing");
      expect(all.actions.includes("video.expiry") && all.targets.includes("settings"), "filter choices");
      expect((await listAudit(auditListQuerySchema.parse({ page: "x" }))).rows.length > 0, "a bad page should fall back to 1");
    });
  } finally {
    await cloudinary.api.delete_resources_by_prefix(`${cfg.baseFolder}/`, { resource_type: "raw", type: "authenticated" }).catch(() => {});
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.disconnect();
    for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.ok ? "" : `\n    ${r.detail}`}`);
    const failedCount = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failedCount}/${results.length} passed · database "${dbName}" dropped · Cloudinary "${cfg.baseFolder}/" cleaned\n`);
    process.exitCode = failedCount ? 1 : 0;
  }
}

main().catch((err) => {
  console.error(err instanceof AppError ? `${err.code}: ${err.message}` : err);
  process.exit(1);
});
