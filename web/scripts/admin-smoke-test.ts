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
