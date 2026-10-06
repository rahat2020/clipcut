/**
 * Proves Step 12 (rendering).
 *
 *   npm run render:smoke
 *
 * Pure checks (caption phrases, ASS, render spec + hash), then real ffmpeg: a generated
 * 1920×1080 video with Bangla audio → 1080×1920 H.264 with burned-in Bangla captions (a frame
 * is saved to .scratch/render-smoke/frame.png to look at), 60 → 30 fps, a vertical source.
 * Then a real YouTube section download (7 s of "Me at the zoo"), and against a throwaway
 * database <MONGODB_DB>_rendertest + Cloudinary "smoketest/": the pipeline's copy + render
 * stages (top 3 clips), a stage retry that renders nothing twice, a user-requested render
 * through the render queue, and the stuck-render sweep. Everything is cleaned afterwards.
 */
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

process.env.CLOUDINARY_FOLDER = "smoketest";

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

const BN_SEGMENTS = [
  [0, 6_000, "আমরা বিশ্বাস করি যে বাংলাদেশ টিম ম্যানেজমেন্ট পুরো বিষয়টা বিবেচনা করবে।"],
  [6_000, 12_000, "আগামী দুই মাস তিন মাস আমাদের এই গুরুত্বপূর্ণ ক্রিকেটগুলো আছে।"],
  [12_000, 18_000, "সেগুলোকে বিবেচনা করে দল গঠন করবে? অ্যাটলিস্ট BCB সেভাবেই করেছে।"],
  [18_000, 24_000, "প্লেয়ারদের সুস্থতা তাদের ওয়েলবিং এবং কন্ডিশন অবশ্যই বিবেচনায় থাকে।"],
  [24_000, 30_000, "এই সিরিজও ইনশাআল্লাহ ব্যতিক্রম হবে না, আমরা আশা করি।"],
  [30_000, 36_000, "ধন্যবাদ সবাইকে, আবার দেখা হবে।"],
].map(([startMs, endMs, text]) => ({ startMs: startMs as number, endMs: endMs as number, text: text as string }));

async function main() {
  const { env } = await import("../src/config/env");
  const { connectDb, disconnectDb } = await import("../src/lib/db");
  const { logger } = await import("../src/lib/logger");
  const { runShutdownHooks } = await import("../src/lib/shutdown");
  const { runTool } = await import("../src/lib/exec");
  const { buildAss, buildPhrases, clipWords, wordsFromSegments } = await import("../src/services/render/captions");
  const { COVER_FRAMES, encodeClip, extractCoverFrames, prepareFonts } = await import("../src/services/render/encode");
  const { probeMedia } = await import("../src/services/media/ffprobe");
  const { downloadYouTubeSection } = await import("../src/services/media/ytdlp");
  const { cloudinary, signedPrivateUrl, uploadPrivateVideo } = await import("../src/services/storage/cloudinary");
  const { processPipelineJob } = await import("../src/processors/pipeline-processor");
  const { processRenderJob, withSectionRetries } = await import("../src/processors/render-processor");
  const { RenderDispatcher } = await import("../src/renders/dispatcher");
  const { claimQueuedRender } = await import("../src/renders/store");
  const { STAGE_HANDLERS } = await import("../src/pipeline/stages");
  const shared = await import("../src/shared");
  const { AnalysisRun, captionStyle, Clip, newRunId, pipelineJobId, Render, RENDER_TIMING, renderSpecForClip, renderSpecHash, Transcript, UsageEvent, User, Video } =
    shared;
  const mongoose = (await import("mongoose")).default;
  type PJob = import("bullmq").Job<import("../src/shared").PipelineJobData>;
  type RJob = import("bullmq").Job<import("../src/shared").RenderJobData>;
  logger.level = "silent";

  const TEST_DB = `${env.MONGODB_DB}_rendertest`;
  const SCRATCH = path.join(env.SCRATCH_DIR, "render-smoke");
  await rm(SCRATCH, { recursive: true, force: true });
  await mkdir(SCRATCH, { recursive: true });
  console.log(`\nRender smoke test → db "${TEST_DB}", Cloudinary "smoketest/" (both cleaned afterwards)\n`);

  const ff = (args: string[]) => runTool(env.FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", "-y", ...args], { timeoutMs: 120_000 });
  const style = captionStyle("preset:bold");
  const size = { width: 1080, height: 1920 };

  // ── pure ──────────────────────────────────────────────────

  await test("captions: phrases close at sentence ends, pauses and the length limit; times relative to the clip", () => {
    const words: [number, number, string][] = [
      [10_000, 10_300, "আমরা"], [10_300, 10_700, "বিশ্বাস"], [10_700, 11_000, "করি।"],
      [11_100, 11_400, "আগামী"], [11_400, 11_700, "দুই"], [11_700, 12_000, "মাস"], [12_000, 12_300, "তিন"], [12_300, 12_600, "মাস"],
      [13_500, 13_900, "BCB"], [13_900, 14_400, "সেভাবেই"], [14_400, 30_000, "outside"],
    ];
    const cw = clipWords(words, 10_000, 15_000);
    assert(cw.length === 10 && cw[0]![0] === 0, `clip words ${cw.length}, first at ${cw[0]?.[0]}`);
    const phrases = buildPhrases(cw, style, 5_000);
    assert(phrases[0]!.text === "আমরা বিশ্বাস করি", `first "${phrases[0]!.text}" (trailing । dropped)`);
    assert(phrases[1]!.text.split(" ").length <= style.maxWords, `second "${phrases[1]!.text}"`);
    assert(phrases.some((p) => p.text.startsWith("BCB")), "pause didn't start a new phrase");
    assert(phrases.every((p, i) => p.endMs > p.startMs && p.endMs <= 5_000 && (i === 0 || p.startMs >= phrases[i - 1]!.endMs)), JSON.stringify(phrases));
  });

  await test("captions: ASS has the output size and font; speech can't inject ASS tags", () => {
    const ass = buildAss([{ startMs: 0, endMs: 1_500, text: "হ্যালো {\\b1} ok" }], style, size);
    assert(ass.includes("PlayResX: 1080") && ass.includes("PlayResY: 1920"), "play res");
    assert(ass.includes("Style: Caption,Hind Siliguri,96,"), `style line ${ass.split("\n").find((l) => l.startsWith("Style:"))}`);
    assert(ass.includes("Dialogue: 0,0:00:00.00,0:00:01.50,Caption") && ass.includes("হ্যালো (/b1) ok"), ass.split("\n").at(-2) ?? "");
  });

  await test("captions: without word times, segment text is spread over the segment by length", () => {
    const w = wordsFromSegments([{ startMs: 1_000, endMs: 3_000, text: "ab abcd  ab" }]);
    assert(w.length === 3 && w[0]![0] === 1_000 && w[2]![1] === 3_000, JSON.stringify(w));
    assert(w[1]![1] - w[1]![0] > w[0]![1] - w[0]![0], "longer word got less time");
  });

  await test("spec: Bangla → Beng captions (Latn when Banglish), English → Latn; offset clamped; hash stable and spec-sensitive", () => {
    const clip = { startMs: 1_000.4, endMs: 20_000, edit: { cropOffsetX: 3, captionStyleId: "brandkit:gone" } };
    const bn = renderSpecForClip(clip, { language: "bn" }, 1);
    const en = renderSpecForClip(clip, { language: "en", aspectRatio: "1:1" }, 1);
    const banglish = renderSpecForClip(clip, { language: "bn", captionScript: "Latn" }, 1);
    const enForced = renderSpecForClip(clip, { language: "en", captionScript: "Beng" }, 1);
    assert(bn.captionScript === "Beng" && en.captionScript === "Latn" && banglish.captionScript === "Latn" && enForced.captionScript === "Latn", "scripts");
    assert(renderSpecHash(bn) !== renderSpecHash(banglish), "Banglish switch doesn't make renders outdated");
    assert(bn.cropOffsetX === 1 && bn.startMs === 1_000 && bn.width === 1080 && bn.height === 1920 && en.height === 1080, JSON.stringify(bn));
    assert(bn.captionStyleId === "preset:bold", `unknown style → ${bn.captionStyleId}`);
    assert(renderSpecHash(bn) === renderSpecHash({ ...bn }), "hash not stable");
    assert(renderSpecHash(bn) !== renderSpecHash({ ...bn, cropOffsetX: 0.5 }) && renderSpecHash(bn) !== renderSpecHash({ ...bn, transcriptVersion: 2 }), "hash ignores changes");
  });

  // ── real ffmpeg ───────────────────────────────────────────

  const wide = path.join(SCRATCH, "wide.mp4");
  const fixtureAudio = path.join(env.SCRATCH_DIR, "fixtures", "bn-podcast-120s.ogg");
  await ff(["-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30", "-i", fixtureAudio, "-t", "40", "-c:v", "libx264", "-preset", "veryfast", "-crf", "32", "-c:a", "aac", "-shortest", wide]);
  await prepareFonts(SCRATCH);

  await test("encode: 16:9 1080p → 1080×1920 H.264/AAC, exact length, Bangla captions burned in", async () => {
    const words = wordsFromSegments(BN_SEGMENTS);
    const phrases = buildPhrases(clipWords(words, 6_000, 18_000), style, 12_000);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(SCRATCH, "captions.ass"), buildAss(phrases, style, size));
    const out = path.join(SCRATCH, "out.mp4");
    const t0 = Date.now();
    await encodeClip({ input: wide, output: out, inputStartMs: 6_000, durationMs: 12_000, aspect: "9:16", width: 1080, height: 1920, cropOffsetX: 0, workDir: SCRATCH, assFile: "captions.ass", sourceFps: 30, requireAudio: true, crf: 21, preset: "veryfast" });
    const encodeMs = Date.now() - t0;
    const p = await probeMedia(out);
    assert(p.width === 1080 && p.height === 1920 && p.videoCodec === "h264" && p.audioCodec === "aac", JSON.stringify(p));
    assert(Math.abs(p.durationMs - 12_000) < 150, `duration ${p.durationMs}`);
    await ff(["-ss", "3", "-i", out, "-frames:v", "1", path.join(SCRATCH, "frame.png")]);
    console.log(`   (12 s clip encoded in ${(encodeMs / 1000).toFixed(1)} s; frame → ${path.join(SCRATCH, "frame.png")})`);
  });

  await test("encode: 60 fps source → 30 fps; a vertical source fills 9:16 without black bars", async () => {
    const fast = path.join(SCRATCH, "fast.mp4");
    await ff(["-f", "lavfi", "-i", "testsrc2=size=720x1280:rate=60", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "4", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", fast]);
    const out = path.join(SCRATCH, "fast-out.mp4");
    await encodeClip({ input: fast, output: out, inputStartMs: 500, durationMs: 3_000, aspect: "9:16", width: 1080, height: 1920, cropOffsetX: -1, workDir: SCRATCH, assFile: null, sourceFps: 60, requireAudio: true, crf: 23, preset: "veryfast" });
    const p = await probeMedia(out);
    assert(p.width === 1080 && p.height === 1920 && Math.round(p.fps ?? 0) === 30, JSON.stringify(p));
  });

  await test("cover frames: 6 clean 1080×1920 JPEGs spread over the clip, same crop, no captions", async () => {
    const dir = path.join(SCRATCH, "covers");
    await (await import("node:fs/promises")).rm(dir, { recursive: true, force: true });
    await (await import("node:fs/promises")).mkdir(dir, { recursive: true });
    const t0 = Date.now();
    const files = await extractCoverFrames({ input: wide, inputStartMs: 4_000, durationMs: 30_000, aspect: "9:16", width: 1080, height: 1920, cropOffsetX: 0, workDir: dir });
    assert(files.length === COVER_FRAMES, `${files.length} frames: ${files}`);
    const probe = await probeMedia(path.join(dir, files[0]!));
    assert(probe.width === 1080 && probe.height === 1920, `size ${probe.width}×${probe.height}`);
    const sizes = await Promise.all(files.map(async (f) => (await (await import("node:fs/promises")).stat(path.join(dir, f))).size));
    assert(sizes.every((b) => b > 10_000 && b < 1_500_000), `bytes ${sizes}`);
    console.log(`   (${files.length} cover frames in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${Math.round(sizes.reduce((a, b) => a + b, 0) / 1024)} KB)`);
  });

  await test("encode: a source without sound fails when sound is required (no silent clips)", async () => {
    const mute = path.join(SCRATCH, "mute.mp4");
    await ff(["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-t", "3", "-c:v", "libx264", "-preset", "ultrafast", mute]);
    let failed = false;
    await encodeClip({ input: mute, output: path.join(SCRATCH, "mute-out.mp4"), inputStartMs: 0, durationMs: 2_000, aspect: "9:16", width: 1080, height: 1920, cropOffsetX: 0, workDir: SCRATCH, assFile: null, sourceFps: 30, requireAudio: true, crf: 23, preset: "veryfast" }).catch(() => {
      failed = true;
    });
    assert(failed, "encoded a silent clip although sound was required");
  });

  // ── YouTube section ───────────────────────────────────────

  await test("youtube section: a one-off download failure is tried again; YouTube blocking us is not", async () => {
    const { AppError } = await import("../src/shared");
    const dir = path.join(env.SCRATCH_DIR, "render-smoke", "retry");
    await (await import("node:fs/promises")).mkdir(dir, { recursive: true });
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls === 1) throw new AppError("DOWNLOAD_FAILED");
      return "section.mp4";
    };
    assert((await withSectionRetries(flaky, dir, logger)) === "section.mp4" && calls === 2, `calls ${calls}`);
    calls = 0;
    const blocked = async () => {
      calls++;
      throw new AppError("DOWNLOAD_FAILED", { message: "YouTube is blocking downloads right now. Try again later, or upload the file instead." });
    };
    const code = await withSectionRetries(blocked, dir, logger).then(() => "no error", (e: unknown) => (e as { code?: string }).code);
    assert(code === "DOWNLOAD_FAILED" && calls === 1, `blocked: ${code} after ${calls} calls`);
  });

  await test("youtube: only the clip's part is downloaded, cut where asked", async () => {
    const dir = path.join(SCRATCH, "yt");
    await mkdir(dir, { recursive: true });
    const file = await downloadYouTubeSection({ videoId: "jNQXAC9IVRw", dir, startMs: 5_000, endMs: 12_000, maxHeight: 1080 });
    const p = await probeMedia(file);
    assert(Math.abs(p.durationMs - 7_000) < 600, `section is ${p.durationMs} ms, asked 7000`);
    assert(p.hasVideo && p.hasAudio && (p.height ?? 0) <= 1080, JSON.stringify(p));
  });

  // ── database: pipeline stage + render queue ───────────────

  await connectDb({ dbName: TEST_DB, autoIndex: false });
  await Promise.all([Render.syncIndexes(), UsageEvent.syncIndexes()]);
  const pjob = (videoId: unknown, runId: string) =>
    ({ id: pipelineJobId(String(videoId), runId), data: { v: 1, videoId: String(videoId), runId }, attemptsMade: 0, opts: { attempts: 1 } }) as unknown as PJob;
  const rjob = (renderId: unknown, queuedAt: Date) =>
    ({ id: `render-${String(renderId)}`, data: { v: 1, renderId: String(renderId), queuedAt: queuedAt.getTime() } }) as unknown as RJob;
  const DONE = { status: "done" as const, progress: 1 };
  type StageHandler = import("../src/pipeline/stages/types").StageHandler;
  // Post text has its own test (copy:smoke); here it is skipped so no AI is called.
  const RENDER_STAGES = { copy: (async () => "skipped") as StageHandler, render: STAGE_HANDLERS.render };

  try {
    const user = await User.create({ clerkId: "user_render", email: "render@example.com" });
    const videoId = new mongoose.Types.ObjectId();
    const sourceId = `smoketest/sources/${String(user._id)}/${String(videoId)}`;
    await uploadPrivateVideo(wide, sourceId);

    const transcript = await Transcript.create({ videoId, userId: user._id, version: 1, kind: "asr", language: "bn", script: "Beng", durationMs: 36_000, segments: BN_SEGMENTS });
    const run = await AnalysisRun.create({
      videoId,
      userId: user._id,
      transcriptId: transcript._id,
      kind: "initial",
      input: { intent: "best", targetClipCount: 4, minClipMs: 5_000, maxClipMs: 20_000 },
      ai: { provider: "gemini", model: "x", promptVersion: "clip-select@1" },
      status: "done",
    });
    const clips = await Clip.insertMany(
      [[0, 6_000], [6_000, 12_000], [12_000, 18_000], [24_000, 30_000]].map(([s, e], i) => ({
        videoId,
        userId: user._id,
        analysisRunId: run._id,
        origin: "ai",
        rank: i + 1,
        startMs: s,
        endMs: e,
        durationMs: e! - s!,
      })),
    );
    const runId = newRunId();
    await Video.create({
      _id: videoId,
      userId: user._id,
      title: "Render test",
      language: "bn",
      source: { type: "upload", cloudinary: { publicId: sourceId, format: "mp4" } },
      permission: { confirmedAt: new Date(), termsVersion: "2026-09-28" },
      media: { durationMs: 40_000, width: 1920, height: 1080, fps: 30, hasAudio: true },
      currentTranscriptId: transcript._id,
      status: "queued",
      pipeline: { runId, stages: { ingest: DONE, audio: DONE, transcribe: DONE } },
    });

    await test("pipeline: clips picked earlier in the same job → copy skipped, the best 3 rendered with sound; video ready", async () => {
      // Like analyze, but it only writes the database — the 2026-10-02 bug: render saw no clips and skipped.
      const analyze: StageHandler = async (ctx) => {
        await ctx.run.setFields({ currentAnalysisRunId: run._id, "counts.clips": clips.length });
      };
      const t0 = Date.now();
      await processPipelineJob(pjob(videoId, runId), { scratchRoot: SCRATCH, handlers: { analyze, ...RENDER_STAGES } }).catch(() => {});
      const v = await Video.findById(videoId).lean().orFail();
      assert(v.status === "ready", `status ${v.status} (${v.error?.code}: ${v.error?.message})`);
      assert(v.pipeline?.stages?.copy?.status === "skipped" && v.pipeline?.stages?.render?.status === "done", "stage states");
      const renders = await Render.find({ videoId }).lean();
      assert(renders.length === 3 && renders.every((r) => r.status === "ready" && r.output?.publicId?.startsWith(`smoketest/renders/${String(user._id)}/`)), JSON.stringify(renders.map((r) => [r.status, r.error])));
      assert(renders.every((r) => r.coverFrames?.length === COVER_FRAMES && r.coverFrames[0] === `${r.output!.publicId}-cover-1`), `cover frames ${JSON.stringify(renders.map((r) => r.coverFrames?.length))}`);
      const done = await Clip.find({ videoId }).sort({ rank: 1 }).lean();
      assert(done.slice(0, 3).every((c) => c.signals?.rendered && c.latestRenderId) && !done[3]!.latestRenderId, "clip flags");
      assert(v.counts?.renders === 3 && (await UsageEvent.countDocuments({ videoId, type: "render" })) === 3, `counts ${v.counts?.renders}`);
      const stored = await probeMedia(signedPrivateUrl(renders[0]!.output!.publicId, "mp4"));
      assert(stored.hasAudio && stored.audioCodec === "aac" && stored.width === 1080, `stored MP4 ${JSON.stringify(stored)}`);
      console.log(`   (3 clips rendered + uploaded in ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    });

    await test("pipeline retry: already-rendered clips are reused, nothing renders twice", async () => {
      const again = newRunId();
      await Video.updateOne({ _id: videoId }, { $set: { status: "queued", "pipeline.runId": again, "pipeline.stages.render.status": "pending" } });
      await processPipelineJob(pjob(videoId, again), { scratchRoot: SCRATCH, handlers: RENDER_STAGES }).catch(() => {});
      const v = await Video.findById(videoId).lean().orFail();
      assert(v.status === "ready" && v.counts?.renders === 3 && (await Render.countDocuments({ videoId })) === 3, `status ${v.status}, renders ${v.counts?.renders}`);
    });

    await test("later YouTube run (Find new clips): source not on disk → the new best clips go to the render queue, nothing downloaded", async () => {
      const run2 = await AnalysisRun.create({
        videoId,
        userId: user._id,
        transcriptId: transcript._id,
        kind: "regenerate",
        input: { intent: "funny", targetClipCount: 2, minClipMs: 5_000, maxClipMs: 20_000 },
        ai: { provider: "gemini", model: "x", promptVersion: "clip-select@1" },
        status: "done",
      });
      const fresh = await Clip.insertMany(
        [[18_000, 24_000], [30_000, 36_000]].map(([s, e], i) => ({ videoId, userId: user._id, analysisRunId: run2._id, origin: "ai", rank: i + 1, startMs: s, endMs: e, durationMs: e! - s! })),
      );
      const analyze: StageHandler = async (ctx) => {
        await ctx.run.setFields({ currentAnalysisRunId: run2._id });
        ctx.video.currentAnalysisRunId = run2._id;
      };
      const again = newRunId();
      await Video.updateOne(
        { _id: videoId },
        {
          $set: {
            status: "queued",
            "pipeline.runId": again,
            "pipeline.stages.analyze.status": "pending",
            "pipeline.stages.render.status": "pending",
            source: { type: "youtube", externalId: "aqz-KE-bpKQ" },
          },
        },
      );
      const t0 = Date.now();
      await processPipelineJob(pjob(videoId, again), { scratchRoot: SCRATCH, handlers: { analyze, ...RENDER_STAGES } }).catch(() => {});
      const v = await Video.findById(videoId).lean().orFail();
      assert(v.status === "ready" && v.pipeline?.stages?.render?.status === "done", `status ${v.status} render ${v.pipeline?.stages?.render?.status} (${v.error?.code})`);
      const queued = await Render.find({ clipId: { $in: fresh.map((c) => c._id) } }).lean();
      assert(queued.length === 2 && queued.every((r) => r.status === "queued" && r.timings?.queuedAt), JSON.stringify(queued.map((r) => r.status)));
      const after = await Clip.find({ _id: { $in: fresh.map((c) => c._id) } }).lean();
      assert(after.every((c) => queued.some((r) => String(r._id) === String(c.latestRenderId))), "latestRenderId not set");
      assert(Date.now() - t0 < 15_000, `took ${Date.now() - t0} ms — did it download the source?`);
      await Render.deleteMany({ _id: { $in: queued.map((r) => r._id) } }); // the queue test below expects only its own
      await Clip.updateMany({ _id: { $in: fresh.map((c) => c._id) } }, { $unset: { latestRenderId: 1 } });
      await Video.updateOne({ _id: videoId }, { $set: { currentAnalysisRunId: run._id, source: { type: "upload", cloudinary: { publicId: sourceId, format: "mp4" } } } });
    });

    await test("render queue: a user-requested render of clip 4 is claimed, rendered and stored", async () => {
      const clip = clips[3]!;
      const spec = renderSpecForClip({ startMs: clip.startMs!, endMs: clip.endMs! }, { language: "bn" }, 1);
      const queuedAt = new Date();
      const r = await Render.create({ clipId: clip._id, videoId, userId: user._id, spec, specHash: renderSpecHash(spec), status: "queued", timings: { queuedAt } });
      assert((await claimQueuedRender(String(r._id), new Date(queuedAt.getTime() - 1))) === null, "claimed with the wrong queuedAt");
      const outcome = await processRenderJob(rjob(r._id, queuedAt), { scratchRoot: SCRATCH });
      const after = await Render.findById(r._id).lean().orFail();
      assert(outcome === "ready" && after.status === "ready" && after.attempts === 1 && after.output?.bytes, `${outcome} / ${after.status} ${JSON.stringify(after.error)}`);
      assert((await processRenderJob(rjob(r._id, queuedAt), { scratchRoot: SCRATCH })) === "skipped", "a finished render ran again");
    });

    await test("stuck sweep: a silent render goes back to the queue; after too many attempts it fails", async () => {
      const old = new Date(Date.now() - RENDER_TIMING.stuckAfterMs - 60_000);
      const base = { videoId, userId: user._id, spec: renderSpecForClip({ startMs: 24_000, endMs: 30_000 }, { language: "bn" }, 7), status: "rendering" as const };
      const a = await Render.create({ ...base, clipId: clips[3]!._id, specHash: "stuck-a", attempts: 1, timings: { queuedAt: old, startedAt: old, heartbeatAt: old } });
      const b = await Render.create({ ...base, clipId: clips[3]!._id, specHash: "stuck-b", attempts: RENDER_TIMING.maxAttempts, timings: { queuedAt: old, startedAt: old, heartbeatAt: old } });
      const r = await new RenderDispatcher({} as never).recoverStuck();
      const [aa, bb] = await Promise.all([Render.findById(a._id).lean().orFail(), Render.findById(b._id).lean().orFail()]);
      assert(r.requeued === 1 && r.failed === 1, JSON.stringify(r));
      assert(aa.status === "queued" && aa.timings!.queuedAt! > old && bb.status === "failed" && bb.error?.code === "PROCESSING_STALLED", `${aa.status} / ${bb.status}`);
    });
  } finally {
    for (const rt of ["video", "image"] as const) {
      await cloudinary.api.delete_resources_by_prefix("smoketest/", { resource_type: rt, type: "authenticated" }).catch(() => {});
    }
    if (mongoose.connection.db?.databaseName === TEST_DB) await mongoose.connection.db.dropDatabase().catch(() => {});
    await disconnectDb().catch(() => {});
    await runShutdownHooks(() => {});
  }

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.ok ? "" : `\n    → ${r.detail}`}`);
  console.log(`\n${passed}/${results.length} passed · test database and smoketest/ files removed\n`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
