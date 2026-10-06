/**
 * Proves Step 6 (ingest + audio) against the real tools and services.
 *
 *   npm run media:smoke
 *
 * Real ffmpeg/ffprobe/yt-dlp, real YouTube (a 19-second public video), real Cloudinary
 * in its own `smoketest/` folder (emptied afterwards), throwaway database
 * <MONGODB_DB>_mediatest (dropped). Needs internet.
 */
import { execFile } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

// Must be set before the worker's env module loads (dynamic imports below).
process.env.CLOUDINARY_FOLDER = "smoketest";

const run = promisify(execFile);

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

async function main() {
  const { env } = await import("../src/config/env");
  const { connectDb, disconnectDb } = await import("../src/lib/db");
  const { logger } = await import("../src/lib/logger");
  const { probeMedia } = await import("../src/services/media/ffprobe");
  const { audioBitrateKbps, extractAudio } = await import("../src/services/media/audio");
  const { mapYtDlpError, probeYouTube } = await import("../src/services/media/ytdlp");
  const { ToolError } = await import("../src/lib/exec");
  const { cloudinary, audioPublicId } = await import("../src/services/storage/cloudinary");
  const { processPipelineJob } = await import("../src/processors/pipeline-processor");
  const { STAGE_HANDLERS } = await import("../src/pipeline/stages");
  // Only the stages under test: later ones stop the run with STAGE_NOT_READY.
  const MEDIA_STAGES = { ingest: STAGE_HANDLERS.ingest, audio: STAGE_HANDLERS.audio };
  const shared = await import("../src/shared");
  const { AppError, newRunId, pipelineJobId, User, Video } = shared;
  const mongoose = (await import("mongoose")).default;
  const { UnrecoverableError } = await import("bullmq");
  type Job = import("bullmq").Job<import("../src/shared").PipelineJobData>;

  logger.level = "silent";
  const TEST_DB = `${env.MONGODB_DB}_mediatest`;
  const DIR = path.join(env.SCRATCH_DIR, "media-smoke");
  const SCRATCH = path.join(DIR, "jobs");
  await rm(DIR, { recursive: true, force: true });
  await mkdir(SCRATCH, { recursive: true });
  const ff = (args: string[]) => run(env.FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", "-y", ...args]);

  console.log(`\nMedia smoke test → db "${TEST_DB}", Cloudinary "smoketest/" (both cleaned afterwards)\n`);
  console.log("Generating test files…");
  const withAudio = path.join(DIR, "talk.mp4");
  const noAudio = path.join(DIR, "silent.mp4");
  const rotated = path.join(DIR, "phone.mp4");
  await ff(["-f", "lavfi", "-i", "testsrc=size=640x360:rate=25", "-f", "lavfi", "-i", "sine=frequency=440",
    "-t", "5", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac", "-shortest", withAudio]);
  await ff(["-f", "lavfi", "-i", "testsrc=size=640x360:rate=25", "-t", "3", "-pix_fmt", "yuv420p", "-c:v", "libx264", noAudio]);
  await ff(["-display_rotation", "90", "-i", withAudio, "-c", "copy", rotated]);

  await connectDb({ dbName: TEST_DB, autoIndex: false });
  const db = mongoose.connection.db!;
  for (const c of await db.listCollections().toArray()) await db.dropCollection(c.name);

  const fakeJob = (videoId: unknown, runId: string): Job =>
    ({ id: pipelineJobId(String(videoId), runId), data: { v: 1, videoId: String(videoId), runId }, attemptsMade: 0, opts: { attempts: 3 } }) as unknown as Job;
  const isUnrecoverable = (e: unknown) => e instanceof UnrecoverableError;

  try {
    // ── pure rules ──
    await test("audio bitrate: 48 kbps up to ~1 h, fits 24 MB for longer, never below 16", async () => {
      const k = (min: number) => audioBitrateKbps(min * 60_000);
      assert(k(30) === 48 && k(60) === 48, `30/60 min → ${k(30)}/${k(60)}`);
      assert(k(120) === 27, `120 min → ${k(120)}`);
      assert(k(180) === 18, `180 min → ${k(180)}`);
      assert(k(400) === 16, `400 min → ${k(400)}`);
      assert((k(180) * 1000 * 180 * 60) / 8 < 24 * 1024 * 1024, "3 h at that bitrate is over 24 MB");
    });

    await test("yt-dlp errors → user-facing codes", async () => {
      const tool = (stderr: string) => new ToolError("yt-dlp", "exit", 1, stderr);
      const code = (stderr: string) => mapYtDlpError(tool(stderr)).code;
      assert(code("ERROR: [youtube] abc: Private video. Sign in if you've been granted access") === "VIDEO_UNAVAILABLE", "private");
      assert(code("ERROR: [youtube] abc: Video unavailable") === "VIDEO_UNAVAILABLE", "unavailable");
      assert(code("ERROR: Sign in to confirm your age") === "VIDEO_UNAVAILABLE", "age");
      assert(code("ERROR: Requested format is not available") === "DOWNLOAD_FAILED", "format error misread as unavailable");
      assert(code("ERROR: Sign in to confirm you’re not a bot") === "DOWNLOAD_FAILED", "bot check");
      assert(code("ERROR: unable to download video data: HTTP Error 403") === "DOWNLOAD_FAILED", "http");
    });

    // ── ffprobe / ffmpeg ──
    await test("ffprobe: length, size, fps, codecs, audio", async () => {
      const p = await probeMedia(withAudio);
      assert(Math.abs(p.durationMs - 5000) < 150, `duration ${p.durationMs}`);
      assert(p.width === 640 && p.height === 360 && p.fps === 25, `${p.width}x${p.height}@${p.fps}`);
      assert(p.hasVideo && p.hasAudio && p.videoCodec === "h264" && p.audioCodec === "aac", JSON.stringify(p));
      const s = await probeMedia(noAudio);
      assert(s.hasVideo && !s.hasAudio, "silent file reported audio");
    });

    await test("ffprobe: phone video rotated 90° → displayed size is portrait", async () => {
      const p = await probeMedia(rotated);
      assert(p.rotation === 90 || p.rotation === 270, `rotation ${p.rotation}`);
      assert(p.width === 360 && p.height === 640, `${p.width}x${p.height}`);
    });

    await test("audio: mono 16 kHz Opus/Ogg, same length, progress reported", async () => {
      const out = path.join(DIR, "talk.ogg");
      let last = 0;
      await extractAudio({ input: withAudio, output: out, durationMs: 5000, bitrateKbps: 48, onProgress: (f) => (last = f) });
      const { stdout } = await run(env.FFPROBE_PATH, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", out]);
      const j = JSON.parse(stdout) as { streams: { codec_name: string; sample_rate: string; channels: number }[]; format: { duration: string } };
      const a = j.streams[0]!;
      assert(a.codec_name === "opus" && a.channels === 1, `${a.codec_name} ${a.channels}ch`);
      assert(Math.abs(Number(j.format.duration) - 5) < 0.2, `duration ${j.format.duration}`);
      assert(last > 0.9, `last progress ${last}`);
    });

    // ── YouTube metadata ──
    await test("yt-dlp: public video info (length, not live, public)", async () => {
      const info = await probeYouTube("jNQXAC9IVRw");
      assert(info.durationMs && Math.abs(info.durationMs - 19_000) < 1_500, `duration ${info.durationMs}`);
      assert(info.liveStatus === "not_live" && info.availability === "public", `${info.liveStatus} / ${info.availability}`);
    });

    await test("yt-dlp: a video that doesn't exist → VIDEO_UNAVAILABLE", async () => {
      try {
        await probeYouTube("zzzzzzzzz0q");
      } catch (e) {
        assert(e instanceof AppError && e.code === "VIDEO_UNAVAILABLE", `got ${e instanceof AppError ? e.code : String(e)}`);
        return;
      }
      throw new Error("expected an error");
    });

    // ── full stages, real services ──
    const user = await User.create({ clerkId: "user_media_smoke", email: "media@example.com" });

    const newVideo = async (source: Record<string, unknown>) => {
      const runId = newRunId();
      const v = await Video.create({
        userId: user._id,
        title: "Media smoke",
        language: "bn",
        source,
        permission: { confirmedAt: new Date(), termsVersion: "2026-09-28" },
        status: "queued",
        pipeline: { runId },
      });
      return { id: v._id, runId };
    };

    const expectStopsAtTranscribe = async (id: unknown, runId: string) => {
      try {
        await processPipelineJob(fakeJob(id, runId), { scratchRoot: SCRATCH, handlers: MEDIA_STAGES });
      } catch (e) {
        assert(isUnrecoverable(e), `unexpected error ${e instanceof Error ? e.message : String(e)}`);
      }
      const v = await Video.findById(id).lean().orFail();
      const st = (n: string) => (v.pipeline?.stages as Record<string, { status?: string }> | undefined)?.[n]?.status;
      assert(st("ingest") === "done" && st("audio") === "done", `ingest ${st("ingest")}, audio ${st("audio")} (${v.error?.code})`);
      assert(v.error?.code === "STAGE_NOT_READY" && v.error.stage === "transcribe", `error ${v.error?.code} at ${v.error?.stage}`);
      return v;
    };

    const assertAudioStored = async (v: { audio?: { publicId?: string | null; bytes?: number | null } | null }, userId: string, videoId: string) => {
      assert(v.audio?.publicId === audioPublicId(userId, videoId), `audio publicId ${v.audio?.publicId}`);
      const r = (await cloudinary.api.resource(v.audio.publicId, { resource_type: "video", type: "authenticated" })) as { bytes: number };
      assert(r.bytes > 0 && r.bytes === v.audio.bytes, `cloudinary bytes ${r.bytes} vs ${v.audio.bytes}`);
    };

    await test("upload: ingest downloads + probes, audio extracted and stored, stops at transcribe", async () => {
      const probeId = new mongoose.Types.ObjectId();
      const publicId = `smoketest/sources/${String(user._id)}/${String(probeId)}`;
      await cloudinary.uploader.upload(withAudio, {
        resource_type: "video",
        type: "authenticated",
        public_id: publicId,
        asset_folder: `smoketest/sources/${String(user._id)}`,
      });
      const { id, runId } = await newVideo({ type: "upload", cloudinary: { publicId, format: "mp4" } });
      const v = await expectStopsAtTranscribe(id, runId);
      assert(v.media && Math.abs(v.media.durationMs - 5000) < 150 && v.media.width === 640, `media ${JSON.stringify(v.media)}`);
      await assertAudioStored(v, String(user._id), String(id));
      assert((await readdir(SCRATCH)).length === 0, "scratch folder left behind");
    });

    await test("upload: file gone from Cloudinary → UPLOAD_NOT_FOUND (no retry)", async () => {
      const { id, runId } = await newVideo({ type: "upload", cloudinary: { publicId: "smoketest/sources/nope/nope", format: "mp4" } });
      await processPipelineJob(fakeJob(id, runId), { scratchRoot: SCRATCH, handlers: MEDIA_STAGES }).catch((e: unknown) =>
        assert(isUnrecoverable(e), `not unrecoverable: ${String(e)}`),
      );
      const v = await Video.findById(id).lean().orFail();
      assert(v.status === "failed" && v.error?.code === "UPLOAD_NOT_FOUND", `${v.status} ${v.error?.code}`);
    });

    await test("youtube: downloaded with yt-dlp, probed, audio stored, stops at transcribe", async () => {
      const { id, runId } = await newVideo({ type: "youtube", externalId: "jNQXAC9IVRw", url: "https://www.youtube.com/watch?v=jNQXAC9IVRw" });
      const v = await expectStopsAtTranscribe(id, runId);
      assert(v.media && Math.abs(v.media.durationMs - 19_000) < 1_500 && v.media.hasAudio, `media ${JSON.stringify(v.media)}`);
      await assertAudioStored(v, String(user._id), String(id));
    });

    await test("youtube: no minutes left → QUOTA_EXCEEDED before anything is downloaded", async () => {
      await User.updateOne({ _id: user._id }, { $set: { quota: { periodStart: new Date(), minutesUsed: 60 } } });
      const { id, runId } = await newVideo({ type: "youtube", externalId: "jNQXAC9IVRw" });
      await processPipelineJob(fakeJob(id, runId), { scratchRoot: SCRATCH, handlers: MEDIA_STAGES }).catch(() => {});
      const v = await Video.findById(id).lean().orFail();
      assert(v.error?.code === "QUOTA_EXCEEDED" && v.error.stage === "ingest", `${v.error?.code} at ${v.error?.stage}`);
      assert(!v.media, "media written although the video was rejected");
      await User.updateOne({ _id: user._id }, { $unset: { quota: 1 } });
    });
  } finally {
    const cleaned = (await cloudinary.api
      .delete_resources_by_prefix("smoketest/", { resource_type: "video", type: "authenticated" })
      .catch((e: unknown) => ({ error: e }))) as { deleted?: Record<string, string> };
    const removed = Object.values(cleaned.deleted ?? {}).filter((s) => s === "deleted").length;
    if (mongoose.connection.db?.databaseName === TEST_DB) await mongoose.connection.db.dropDatabase().catch(() => {});
    await disconnectDb().catch(() => {});
    await rm(DIR, { recursive: true, force: true });
    console.log(`(cleanup: ${removed} Cloudinary file${removed === 1 ? "" : "s"} removed)\n`);
  }
}

main()
  .catch((err: unknown) => results.push({ name: "test run", ok: false, detail: err instanceof Error ? err.message : String(err) }))
  .finally(() => {
    for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.detail ? `\n      → ${r.detail}` : ""}`);
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n${passed}/${results.length} passed · test database and smoketest/ files removed\n`);
    process.exit(passed === results.length ? 0 : 1);
  });
