/**
 * End-to-end check of the upload flow against REAL Cloudinary and MongoDB:
 * rules → signed ticket → chunked upload (same protocol as the browser) → finalize → delete.
 *
 *   npm run upload:smoke
 *
 * Isolation: Cloudinary assets go under "smoketest/" (not dev/ or prod/) and are all deleted
 * at the end; MongoDB uses a throwaway "<MONGODB_DB>_uploadtest" database that is dropped.
 * Test videos are generated with ffmpeg into web/.scratch/ (gitignored). Needs ffmpeg on PATH.
 */
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { loadEnvConfig } from "@next/env";
import { v2 as cloudinary } from "cloudinary";
import mongoose, { Types } from "mongoose";

import { formatEnvIssues, serverEnvSchema } from "../src/lib/env.schema";
import {
  createUploadTicket,
  inspectUploadedVideo,
  sourcePublicId,
  type CloudinaryConfig,
  type UploadTicket,
} from "../src/lib/uploads/cloudinary-core";
import { assertUploadAllowed, titleFromFilename } from "../src/lib/uploads/rules";
import { fetchOEmbed, submitYouTube } from "../src/lib/videos/youtube-service";
import { parseYouTubeUrl } from "../src/lib/videos/youtube-url";
import {
  countActiveJobs,
  deleteVideo,
  finalizeUpload,
  requestUpload,
  retryVideo,
  type UploadContext,
} from "../src/lib/videos/upload-service";
import {
  AppError,
  configureMongoose,
  defaultSettings,
  isAppError,
  minutesUsedThisPeriod,
  planLimitsSchema,
  quotaPeriodEnd,
  User,
  Video,
  type PlanLimits,
} from "../src/shared";

loadEnvConfig(process.cwd());
const run = promisify(execFile);

const SCRATCH = path.resolve(process.cwd(), ".scratch", "upload-smoke");
const SYSTEM = defaultSettings("system");
const LIMITS: PlanLimits = planLimitsSchema.parse({});

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
    return isAppError(err) ? err.code : `non-AppError: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function makeVideo(name: string, args: string[]): Promise<string> {
  const out = path.join(SCRATCH, name);
  await run("ffmpeg", ["-v", "error", "-y", ...args, out], { timeout: 120_000 });
  return out;
}

/** Same protocol the browser uses (lib/uploads/client-upload.ts), with fetch instead of XHR. */
async function uploadFile(ticket: UploadTicket, file: string): Promise<number> {
  const bytes = readFileSync(file);
  let chunks = 0;
  for (let start = 0; start < bytes.length; start += ticket.chunkBytes) {
    const end = Math.min(start + ticket.chunkBytes, bytes.length) - 1;
    const form = new FormData();
    for (const [k, v] of Object.entries(ticket.fields)) form.append(k, v);
    form.append("file", new Blob([bytes.subarray(start, end + 1)]), path.basename(file));
    const res = await fetch(ticket.uploadUrl, {
      method: "POST",
      body: form,
      headers: { "X-Unique-Upload-Id": ticket.videoId, "Content-Range": `bytes ${start}-${end}/${bytes.length}` },
    });
    if (!res.ok) throw new Error(`chunk ${chunks} → HTTP ${res.status}: ${await res.text()}`);
    chunks++;
  }
  return chunks;
}

async function main() {
  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("web/.env.local is invalid:\n" + formatEnvIssues(parsed.error).map((l) => `  - ${l}`).join("\n"));
    process.exit(1);
  }
  const env = parsed.data;
  const cfg: CloudinaryConfig = {
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    apiKey: env.CLOUDINARY_API_KEY,
    apiSecret: env.CLOUDINARY_API_SECRET,
    baseFolder: "smoketest",
  };
  const dbName = `${env.MONGODB_DB}_uploadtest`;

  mkdirSync(SCRATCH, { recursive: true });
  console.log("\nGenerating test videos…");
  const [big, small, silent] = await Promise.all([
    makeVideo("big.mp4", ["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "20", "-c:v", "libx264", "-b:v", "5M", "-maxrate", "5M", "-bufsize", "2M", "-c:a", "aac", "-shortest"]),
    makeVideo("small.mp4", ["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24", "-f", "lavfi", "-i", "sine=frequency=330", "-t", "6", "-c:v", "libx264", "-b:v", "400k", "-c:a", "aac", "-shortest"]),
    makeVideo("silent.mp4", ["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24", "-t", "6", "-c:v", "libx264", "-b:v", "400k", "-an"]),
  ]);

  configureMongoose();
  await mongoose.connect(env.MONGODB_URI, { dbName, serverSelectionTimeoutMS: 15_000 });
  console.log(`Upload smoke test · database "${dbName}" · Cloudinary folder "${cfg.baseFolder}/"\n`);

  try {
    await mongoose.connection.dropDatabase();
    await User.createIndexes();
    await Video.createIndexes();
    const alice = await User.create({ clerkId: "user_upload_alice", email: "alice@example.com" });
    const bob = await User.create({ clerkId: "user_upload_bob", email: "bob@example.com" });
    const ctxFor = (user: typeof alice, limits: Partial<PlanLimits> = {}): UploadContext => ({
      cfg,
      user,
      limits: { ...LIMITS, ...limits },
      system: SYSTEM,
      request: { ip: "203.0.113.7", userAgent: "upload-smoke-test" },
    });
    const base = { originalFilename: "My_Podcast_Ep12.mp4", language: "bn" as const, intent: "best" as const, permission: true as const };

    // ── pure rules ───────────────────────────────────────────
    await test("rules: file over the plan's MB limit → FILE_TOO_LARGE", async () => {
      const c = await codeOf(() => assertUploadAllowed({ user: {}, limits: LIMITS, facts: { bytes: 101 * 1024 * 1024 }, activeJobs: 0 }));
      expect(c === "FILE_TOO_LARGE", `got ${c}`);
    });
    await test("rules: longer than maxDurationMin → VIDEO_TOO_LONG", async () => {
      const c = await codeOf(() => assertUploadAllowed({ user: {}, limits: LIMITS, facts: { bytes: 1, durationMs: 61 * 60_000 }, activeJobs: 0 }));
      expect(c === "VIDEO_TOO_LONG", `got ${c}`);
    });
    await test("rules: not enough minutes left → QUOTA_EXCEEDED", async () => {
      const user = { quota: { periodStart: new Date(), minutesUsed: 55 } };
      const c = await codeOf(() => assertUploadAllowed({ user, limits: LIMITS, facts: { bytes: 1, durationMs: 10 * 60_000 }, activeJobs: 0 }));
      expect(c === "QUOTA_EXCEEDED", `got ${c}`);
    });
    await test("rules: last month's usage doesn't count", async () => {
      const user = { quota: { periodStart: new Date(Date.now() - 40 * 86_400_000), minutesUsed: 60 } };
      expect(minutesUsedThisPeriod(user) === 0, "old period still counted");
      const c = await codeOf(() => assertUploadAllowed({ user, limits: LIMITS, facts: { bytes: 1, durationMs: 10 * 60_000 }, activeJobs: 0 }));
      expect(c === null, `got ${c}`);
    });
    await test("rules: a job already running → CONCURRENCY_LIMIT", async () => {
      const c = await codeOf(() => assertUploadAllowed({ user: {}, limits: LIMITS, facts: { bytes: 1 }, activeJobs: 1 }));
      expect(c === "CONCURRENCY_LIMIT", `got ${c}`);
    });
    await test("rules: uploads switched off → UPLOADS_DISABLED", async () => {
      const ctx = { ...ctxFor(alice), system: { ...SYSTEM, uploadsEnabled: false } };
      const c = await codeOf(() => requestUpload(ctx, { fileName: "a.mp4", sizeBytes: 1, durationMs: 1000, contentType: "video/mp4" }));
      expect(c === "UPLOADS_DISABLED", `got ${c}`);
    });
    await test("quota period: Jan 31 → Feb 28, Dec 15 → Jan 15", async () => {
      const a = quotaPeriodEnd(new Date("2026-01-31T10:00:00Z")).toISOString();
      const b = quotaPeriodEnd(new Date("2026-12-15T00:00:00Z")).toISOString();
      expect(a === "2026-02-28T10:00:00.000Z" && b === "2027-01-15T00:00:00.000Z", `${a} / ${b}`);
    });
    await test("title from file name", async () => {
      expect(titleFromFilename("My_Podcast  Ep12.final.mp4") === "My Podcast Ep12.final", titleFromFilename("My_Podcast  Ep12.final.mp4"));
    });

    // ── ticket ───────────────────────────────────────────────
    await test("ticket: signed for one public id in the user's folder, no secret", async () => {
      const t = createUploadTicket(cfg, { userId: String(alice._id), videoId: new Types.ObjectId().toHexString() });
      expect(t.publicId === `smoketest/sources/${alice._id}/${t.videoId}`, t.publicId);
      expect(t.fields.type === "authenticated" && t.fields.signature?.length === 40, "not authenticated / no signature");
      expect(!JSON.stringify(t).includes(cfg.apiSecret), "API secret leaked into the ticket");
    });

    // ── real upload ──────────────────────────────────────────
    let aliceVideoId = "";
    await test("upload 10 MB in 2 chunks → finalize creates a queued video", async () => {
      const size = statSync(big).size;
      const ticket = await requestUpload(ctxFor(alice), { fileName: "big.mp4", sizeBytes: size, durationMs: 20_000, contentType: "video/mp4" });
      const chunks = await uploadFile(ticket, big);
      expect(chunks === 2, `${chunks} chunks`);
      const { video, created } = await finalizeUpload(ctxFor(alice), { ...base, videoId: ticket.videoId });
      aliceVideoId = ticket.videoId;
      expect(created, "not created");
      expect(video.status === "queued" && video.language === "bn" && video.options?.intent === "best", "wrong status/lang/intent");
      expect(video.title === "My Podcast Ep12", `title ${video.title}`);
      expect(video.source.cloudinary?.bytes === size && video.source.sizeBytes === size, "size mismatch");
      expect(video.media?.durationMs === 20_000 && video.media?.hasAudio === true && video.media?.width === 1280, JSON.stringify(video.media));
      expect(video.permission.termsVersion && video.permission.ip === "203.0.113.7", "permission record incomplete");
      expect(video.thumbnailUrl?.includes("/s--") && video.thumbnailUrl.includes("/authenticated/"), "thumbnail not a signed URL");
    });
    await test("finalize twice → same video, not a second one", async () => {
      const again = await finalizeUpload(ctxFor(alice), { ...base, videoId: aliceVideoId });
      expect(!again.created && String(again.video._id) === aliceVideoId, "second finalize created something");
      expect((await Video.countDocuments({ userId: alice._id })) === 1, "duplicate video");
    });
    await test("thumbnail URL actually serves an image", async () => {
      const v = await Video.findById(aliceVideoId).lean();
      const res = await fetch(v!.thumbnailUrl!);
      expect(res.ok && res.headers.get("content-type")?.startsWith("image/"), `HTTP ${res.status} ${res.headers.get("content-type")}`);
    });
    await test("second upload while one is queued → CONCURRENCY_LIMIT", async () => {
      const c = await codeOf(() => requestUpload(ctxFor(alice), { fileName: "x.mp4", sizeBytes: 1000, durationMs: 5000, contentType: "video/mp4" }));
      expect(c === "CONCURRENCY_LIMIT", `got ${c}`);
    });
    await test("finalize without uploading → UPLOAD_NOT_FOUND", async () => {
      const c = await codeOf(() => finalizeUpload(ctxFor(bob), { ...base, videoId: new Types.ObjectId().toHexString() }));
      expect(c === "UPLOAD_NOT_FOUND", `got ${c}`);
    });
    await test("another user can't claim someone's upload", async () => {
      const c = await codeOf(() => finalizeUpload(ctxFor(bob), { ...base, videoId: aliceVideoId }));
      expect(c === "UPLOAD_NOT_FOUND", `got ${c}`);
      expect((await Video.countDocuments({ userId: bob._id })) === 0, "bob got a video");
      expect(await inspectUploadedVideo(cfg, sourcePublicId(cfg, String(alice._id), aliceVideoId)), "alice's file was touched");
    });
    await test("video without audio → NO_AUDIO_TRACK, file deleted", async () => {
      const ticket = await requestUpload(ctxFor(bob), { fileName: "silent.mp4", sizeBytes: statSync(silent).size, durationMs: 6000, contentType: "video/mp4" });
      await uploadFile(ticket, silent);
      const c = await codeOf(() => finalizeUpload(ctxFor(bob), { ...base, videoId: ticket.videoId }));
      expect(c === "NO_AUDIO_TRACK", `got ${c}`);
      expect((await inspectUploadedVideo(cfg, ticket.publicId)) === null, "rejected file still in Cloudinary");
    });
    await test("server re-checks length with Cloudinary's number, not the browser's", async () => {
      const tight = { maxDurationMin: 0.05 }; // 3 s
      // The browser "says" 2 s so the ticket is issued; the real file is 6 s.
      const ticket = await requestUpload(ctxFor(bob, tight), { fileName: "small.mp4", sizeBytes: statSync(small).size, durationMs: 2000, contentType: "video/mp4" });
      await uploadFile(ticket, small);
      const c = await codeOf(() => finalizeUpload(ctxFor(bob, tight), { ...base, videoId: ticket.videoId }));
      expect(c === "VIDEO_TOO_LONG", `got ${c}`);
      expect((await inspectUploadedVideo(cfg, ticket.publicId)) === null, "rejected file still in Cloudinary");
    });

    // ── delete ───────────────────────────────────────────────
    await test("delete → hidden, canceled, file removed, slot freed", async () => {
      await deleteVideo({ cfg, user: alice }, aliceVideoId);
      const v = await Video.findById(aliceVideoId).lean();
      expect(v?.deletedAt && v.status === "canceled" && v.retention?.assetsDeletedAt, JSON.stringify({ d: v?.deletedAt, s: v?.status }));
      expect((await inspectUploadedVideo(cfg, sourcePublicId(cfg, String(alice._id), aliceVideoId))) === null, "file still in Cloudinary");
      expect((await countActiveJobs(alice._id)) === 0, "slot not freed");
    });
    await test("deleting someone else's video → NOT_FOUND", async () => {
      const c = await codeOf(() => deleteVideo({ cfg, user: bob }, aliceVideoId));
      expect(c === "NOT_FOUND", `got ${c}`);
    });

    // ── retry (Step 5) ───────────────────────────────────────
    const failedVideo = async (user: typeof alice, error: { code: string; retryable: boolean }) =>
      (
        await Video.create({
          userId: user._id,
          title: "Failed video",
          language: "bn",
          source: { type: "upload", sizeBytes: 1_000_000 },
          permission: { confirmedAt: new Date(), termsVersion: "2026-09-28" },
          media: { durationMs: 60_000, hasAudio: true },
          status: "failed",
          error: { ...error, message: "x", stage: "transcribe", at: new Date() },
          retention: { finishedAt: new Date() },
          pipeline: {
            runId: "old-run",
            jobId: "old-job",
            recoveries: 2,
            stages: { ingest: { status: "done", progress: 1 }, transcribe: { status: "failed", progress: 0.4 } },
          },
        })
      )._id;
    await test("retry: failed → queued, new run, failed stage reset, done stages kept, error cleared", async () => {
      const id = await failedVideo(bob, { code: "STAGE_NOT_READY", retryable: true });
      await retryVideo(ctxFor(bob), String(id));
      const v = await Video.findById(id).lean();
      expect(v?.status === "queued" && !v.error && !v.retention?.finishedAt, `status ${v?.status}`);
      expect(v?.pipeline?.runId && v.pipeline.runId !== "old-run" && !v.pipeline.jobId, "run not replaced");
      expect(v?.pipeline?.recoveries === 0, "recoveries not reset");
      expect(v?.pipeline?.stages?.transcribe?.status === "pending", "failed stage not reset");
      expect(v?.pipeline?.stages?.ingest?.status === "done", "finished stage was reset");
    });
    await test("retry: while another video is active → CONCURRENCY_LIMIT; not failed → CONFLICT", async () => {
      const id = await failedVideo(bob, { code: "AI_UNAVAILABLE", retryable: true });
      const c1 = await codeOf(() => retryVideo(ctxFor(bob), String(id))); // bob's first retry is queued
      expect(c1 === "CONCURRENCY_LIMIT", `got ${c1}`);
      const queued = await Video.findOne({ userId: bob._id, status: "queued" }).lean();
      const c2 = await codeOf(() => retryVideo(ctxFor(bob), String(queued?._id)));
      expect(c2 === "CONFLICT", `got ${c2}`);
    });
    await test("retry: non-retryable error → CONFLICT; someone else's video → NOT_FOUND", async () => {
      const id = await failedVideo(alice, { code: "NO_AUDIO_TRACK", retryable: false });
      const c1 = await codeOf(() => retryVideo(ctxFor(alice), String(id)));
      expect(c1 === "CONFLICT", `got ${c1}`);
      const c2 = await codeOf(() => retryVideo(ctxFor(bob), String(id)));
      expect(c2 === "NOT_FOUND", `got ${c2}`);
    });

    // ── YouTube links (Step 6) ───────────────────────────────
    await test("youtube url: watch / youtu.be / shorts / live / embed / mobile accepted; others rejected", async () => {
      const id = "jNQXAC9IVRw";
      for (const u of [
        `https://www.youtube.com/watch?v=${id}&t=10s`,
        `youtube.com/watch?v=${id}`,
        `https://youtu.be/${id}?si=abc`,
        `https://www.youtube.com/shorts/${id}`,
        `https://m.youtube.com/watch?v=${id}`,
        `https://www.youtube.com/live/${id}`,
        `https://www.youtube-nocookie.com/embed/${id}`,
      ]) expect(parseYouTubeUrl(u) === id, `rejected ${u}`);
      for (const u of ["https://vimeo.com/123", "https://www.youtube.com/@channel", "https://www.youtube.com/watch?v=short", "https://evil.com/watch?v=jNQXAC9IVRw", "not a url"])
        expect(parseYouTubeUrl(u) === null, `accepted ${u}`);
    });
    await test("youtube oEmbed: real public video → title; missing video → VIDEO_UNAVAILABLE", async () => {
      const o = await fetchOEmbed("jNQXAC9IVRw");
      expect(o?.title === "Me at the zoo", `title ${o?.title}`);
      const c = await codeOf(() => fetchOEmbed("zzzzzzzzz0q"));
      expect(c === "VIDEO_UNAVAILABLE", `got ${c}`);
    });
    const carol = await User.create({ clerkId: "user_upload_carol", email: "carol@example.com" });
    const link = (extra: Partial<{ url: string; clientRequestId: string }> = {}) => ({
      url: "https://youtu.be/jNQXAC9IVRw",
      clientRequestId: crypto.randomUUID(),
      language: "en" as const,
      intent: "best" as const,
      permission: true as const,
      ...extra,
    });
    const oembed = async () => ({ title: "Me at the zoo", authorName: "jawed", thumbnailUrl: "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg" });
    await test("youtube submit: queued video with canonical url, id, oEmbed title; same request twice → one video", async () => {
      const input = link();
      const a = await submitYouTube(ctxFor(carol), input, { fetchOEmbed: oembed });
      const b = await submitYouTube(ctxFor(carol), input, { fetchOEmbed: oembed });
      expect(a.created && !b.created && String(a.video._id) === String(b.video._id), "not idempotent");
      const v = a.video;
      expect(v.status === "queued" && v.source.type === "youtube" && v.source.externalId === "jNQXAC9IVRw", JSON.stringify(v.source));
      expect(v.source.url === "https://www.youtube.com/watch?v=jNQXAC9IVRw" && v.title === "Me at the zoo", `title ${v.title}`);
    });
    await test("youtube submit: second link while one is queued → CONCURRENCY_LIMIT", async () => {
      const c = await codeOf(() => submitYouTube(ctxFor(carol), link(), { fetchOEmbed: oembed }));
      expect(c === "CONCURRENCY_LIMIT", `got ${c}`);
    });
    await test("youtube submit: switched off / not in plan → YOUTUBE_DISABLED; bad link → UNSUPPORTED_SOURCE", async () => {
      await Video.deleteMany({ userId: carol._id });
      const off = { ...ctxFor(carol), system: { ...SYSTEM, youtubeEnabled: false } };
      expect((await codeOf(() => submitYouTube(off, link(), { fetchOEmbed: oembed }))) === "YOUTUBE_DISABLED", "kill switch ignored");
      const plan = ctxFor(carol, { allowYoutube: false });
      expect((await codeOf(() => submitYouTube(plan, link(), { fetchOEmbed: oembed }))) === "YOUTUBE_DISABLED", "plan ignored");
      const bad = await codeOf(() => submitYouTube(ctxFor(carol), link({ url: "https://vimeo.com/1" }), { fetchOEmbed: oembed }));
      expect(bad === "UNSUPPORTED_SOURCE", `got ${bad}`);
    });
    await test("youtube submit: no minutes left → QUOTA_EXCEEDED", async () => {
      const spent = { ...carol.toObject(), quota: { periodStart: new Date(), minutesUsed: LIMITS.monthlyMinutes } };
      const c = await codeOf(() => submitYouTube({ ...ctxFor(carol), user: spent }, link(), { fetchOEmbed: oembed }));
      expect(c === "QUOTA_EXCEEDED", `got ${c}`);
    });
  } finally {
    // Everything under smoketest/ goes, whatever happened above.
    cloudinary.config({ cloud_name: cfg.cloudName, api_key: cfg.apiKey, api_secret: cfg.apiSecret });
    const cleanup = (await cloudinary.api
      .delete_resources_by_prefix(`${cfg.baseFolder}/`, { resource_type: "video", type: "authenticated" })
      .catch((e: unknown) => ({ error: e }))) as { deleted?: Record<string, string>; error?: unknown };
    const leftovers = Object.values(cleanup.deleted ?? {}).filter((s) => s === "deleted").length;
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.ok ? "" : `\n    ${r.detail}`}`);
    const failed = results.filter((r) => !r.ok).length;
    console.log(
      `\n${results.length - failed}/${results.length} passed · database "${dbName}" dropped · ` +
        `Cloudinary "${cfg.baseFolder}/" cleaned (${leftovers} leftover file${leftovers === 1 ? "" : "s"} removed)\n`,
    );
    process.exitCode = failed ? 1 : 0;
  }
}

main().catch((err) => {
  console.error(err instanceof AppError ? `${err.code}: ${err.message}` : err);
  process.exit(1);
});
