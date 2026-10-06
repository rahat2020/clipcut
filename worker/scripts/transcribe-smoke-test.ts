/**
 * Proves Step 7 (transcription + minutes charging) and D42 (Bangla text from Gemini, piece
 * by piece, Whisper as the fallback).
 *
 *   npm run transcribe:smoke
 *
 * Pure checks always run. The real-Groq checks need two audio fixtures in
 * worker/.scratch/fixtures/ (gitignored; see docs/PROGRESS.md Step 7 for how they were
 * made): bn-podcast-120s.ogg (2 min of a Bangla podcast) and en-zoo-19s.ogg ("Me at the
 * zoo"). They use ~260 s of the Groq audio budget and 1–2 Gemini requests per run. Throwaway database
 * <MONGODB_DB>_transcribetest and Cloudinary "smoketest/" are cleaned afterwards.
 */
import { existsSync } from "node:fs";
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

async function main() {
  const { env } = await import("../src/config/env");
  const { connectDb, disconnectDb } = await import("../src/lib/db");
  const { logger } = await import("../src/lib/logger");
  const { redis } = await import("../src/lib/redis");
  const { runShutdownHooks } = await import("../src/lib/shutdown");
  const { normalizeTranscription } = await import("../src/services/transcription/normalize");
  const { parseGroqDuration } = await import("../src/services/transcription/groq");
  const { chunkAudio, estimateWordTimes } = await import("../src/services/transcription/chunks");
  const { buildPiecesPrompt, checkControls, parsePieces, planSlots } = await import("../src/services/transcription/gemini-pieces");
  const { quietThreshold } = await import("../src/services/media/loudness");
  const { decideLanguage, sampleStarts, toSupportedLanguage } = await import("../src/services/transcription/language");
  const { reserveDailyCap, capKey } = await import("../src/services/ai/daily-caps");
  const { cloudinary, readPrivateJson } = await import("../src/services/storage/cloudinary");
  const { chargeMinutes } = await import("../src/pipeline/usage");
  const { processPipelineJob } = await import("../src/processors/pipeline-processor");
  const { STAGE_HANDLERS } = await import("../src/pipeline/stages");
  // Only the stages under test: the run stops at "analyze" with STAGE_NOT_READY.
  const UP_TO_TRANSCRIBE = { ingest: STAGE_HANDLERS.ingest, audio: STAGE_HANDLERS.audio, transcribe: STAGE_HANDLERS.transcribe };
  const shared = await import("../src/shared");
  const { getSettingsSnapshot, updateSettings } = shared;
  const { AppError, currentQuotaPeriodStart, quotaPeriodEnd, newRunId, pipelineJobId, Transcript, UsageEvent, User, Video } = shared;
  const mongoose = (await import("mongoose")).default;
  type Job = import("bullmq").Job<import("../src/shared").PipelineJobData>;

  logger.level = "silent";
  const TEST_DB = `${env.MONGODB_DB}_transcribetest`;
  const FIXTURES = path.join(env.SCRATCH_DIR, "fixtures");
  const SCRATCH = path.join(env.SCRATCH_DIR, "transcribe-smoke");
  await rm(SCRATCH, { recursive: true, force: true });
  await mkdir(SCRATCH, { recursive: true });
  console.log(`\nTranscription smoke test → db "${TEST_DB}", Cloudinary "smoketest/" (both cleaned afterwards)\n`);

  // ── pure ──────────────────────────────────────────────────
  await test("normalize: ms integers, clamped; silence/noise and repetition loops dropped", () => {
    const raw = {
      text: "",
      segments: [
        { start: 0, end: 2.4567, text: "  আমরা আজ কথা বলব ", avg_logprob: -0.15, no_speech_prob: 0.64 },
        { start: 2.5, end: 5, text: "Thank you for watching", avg_logprob: -1.4, no_speech_prob: 0.9 },
        { start: 5, end: 6, text: "হ্যাঁ।", avg_logprob: -0.3, no_speech_prob: 0.1 },
        { start: 6, end: 7, text: "হ্যাঁ।", avg_logprob: -0.3, no_speech_prob: 0.1 },
        { start: 7, end: 8, text: "হ্যাঁ", avg_logprob: -0.3, no_speech_prob: 0.1 },
        { start: 8, end: 9, text: "হ্যাঁ।", avg_logprob: -0.3, no_speech_prob: 0.1 },
        { start: 9, end: 99, text: "শেষ", avg_logprob: -0.2, no_speech_prob: 0 },
      ],
      words: [
        { word: " আমরা", start: 0, end: 0.5 },
        { word: "watching", start: 3, end: 3.5 },
        { word: "শেষ", start: 9.1, end: 9.6 },
      ],
    };
    const n = normalizeTranscription(raw as Parameters<typeof normalizeTranscription>[0], 10_000);
    assert(n.segments[0]!.endMs === 2457 && n.segments[0]!.text === "আমরা আজ কথা বলব", JSON.stringify(n.segments[0]));
    assert(!n.segments.some((s) => s.text.includes("Thank you")), "silence hallucination kept");
    assert(n.segments.filter((s) => s.text.startsWith("হ্যাঁ")).length === 2, "loop not cut after 2");
    assert(n.segments.at(-1)!.endMs === 10_000, "end not clamped to audio length");
    assert(n.stats.droppedSegments === 3, `dropped ${n.stats.droppedSegments}`);
    assert(n.words.length === 2 && !n.words.some((w) => w[2] === "watching"), `words ${JSON.stringify(n.words)}`);
  });

  await test('normalize: "you" over closing silence dropped; a spoken "Thank you" kept', () => {
    const n = normalizeTranscription(
      {
        text: "",
        segments: [
          { start: 0, end: 2, text: "Thank you so much.", avg_logprob: -0.3, no_speech_prob: 0.02 },
          { start: 2, end: 3, text: "Thank you.", avg_logprob: -0.4, no_speech_prob: 0.1 },
          { start: 343.96, end: 344.58, text: " you", avg_logprob: -0.71, no_speech_prob: 0.73 },
        ],
        words: [],
      } as Parameters<typeof normalizeTranscription>[0],
      345_000,
    );
    assert(n.segments.map((s) => s.text).join("|") === "Thank you so much.|Thank you.", JSON.stringify(n.segments.map((s) => s.text)));
    assert(n.stats.droppedSegments === 1, `dropped ${n.stats.droppedSegments}`);
  });

  await test("normalize: Bangla text is NFC and keeps ZWJ (র‍্যা)", () => {
    const decomposed = "কো".normalize("NFD"); // ক + ো split
    const zwj = "র‍্যাব";
    const n = normalizeTranscription(
      { text: "", segments: [{ start: 0, end: 1, text: `${decomposed} ${zwj}` }], words: [{ word: zwj, start: 0, end: 1 }] } as Parameters<
        typeof normalizeTranscription
      >[0],
      1000,
    );
    assert(n.segments[0]!.text === `${"কো".normalize("NFC")} ${zwj}`, "not NFC or ZWJ lost");
    assert(n.words[0]![2].includes("‍"), "ZWJ stripped from word");
  });

  // ── Gemini pieces (D42) ─────────────────────────────────────
  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p;
      return "no error";
    } catch (e) {
      return e instanceof AppError ? e.code : String(e);
    }
  };
  /** 20 ms frames: speech -20 dB, quiet -60 dB in the given ranges. */
  const loud = (totalMs: number, quiet: [number, number][]) => {
    const db = new Float32Array(Math.ceil(totalMs / 20)).fill(-20);
    for (const [a, b] of quiet) for (let i = Math.floor(a / 20); i < Math.ceil(b / 20); i++) db[i] = -60;
    return { frameMs: 20, db, quietDb: quietThreshold(db) };
  };

  await test("pieces: cut mid-pause, 3–15 s long, no tiny last piece; music (no pause) → quietest spot", () => {
    const l = loud(40_000, [[9_000, 9_600], [21_000, 21_400], [22_500, 23_300], [34_000, 34_400]]);
    const c = chunkAudio(l, 40_000);
    assert(c[0]!.endMs === 9_300, `first cut ${c[0]!.endMs} (pause 9.0–9.6 s)`);
    assert(c[1]!.endMs === 22_900, `second cut ${c[1]!.endMs} (longer pause 22.5–23.3 s wins)`);
    assert(c.every((x) => x.endMs - x.startMs >= 3_000 && x.endMs - x.startMs <= 15_000), JSON.stringify(c));
    assert(c[0]!.startMs === 0 && c.at(-1)!.endMs === 40_000 && c.every((x, i) => i === 0 || x.startMs === c[i - 1]!.endMs), "gaps/overlaps");
    // Music under everything: one slightly quieter dip at 11–11.2 s.
    const db = new Float32Array(1_500).fill(-20);
    for (let i = 550; i < 560; i++) db[i] = -24;
    const m = chunkAudio({ frameMs: 20, db, quietDb: null }, 30_000);
    assert(m[0]!.endMs >= 11_000 && m[0]!.endMs <= 11_200, `music cut at ${m[0]!.endMs}`);
    const tail = chunkAudio(loud(15_500, []), 15_500);
    assert(tail.every((x) => x.endMs - x.startMs >= 3_000), `tiny last piece: ${JSON.stringify(tail)}`);
  });

  await test("pieces: words spread over the speech in order; answers checked; prompt asks for Bengali script", async () => {
    const w = estimateWordTimes("আমি বাংলায় কথা বলি।", { startMs: 10_000, endMs: 14_000 }, loud(20_000, [[10_000, 11_000]]));
    assert(w.length === 4 && w[0]![0] >= 11_000 && w.at(-1)![1] <= 14_000, `skips the quiet start: ${JSON.stringify(w)}`);
    assert(w.every((x, i) => x[1] > x[0] && (i === 0 || x[0] >= w[i - 1]![1] - 1)), "ordered, non-overlapping");
    assert(w[1]![1] - w[1]![0] > w[0]![1] - w[0]![0], "longer word, longer time");
    assert(parsePieces('{"pieces":[{"piece":2,"text":"খ [music]"},{"piece":1,"text":" ক "}]}', 2).join("|") === "ক|খ", "order / cleanup");
    assert((await codeOf(Promise.resolve().then(() => parsePieces('{"pieces":[{"piece":1,"text":"ক"}]}', 2)))) === "AI_OUTPUT_INVALID", "missing piece accepted");
    assert((await codeOf(Promise.resolve().then(() => parsePieces("Sure!", 1)))) === "AI_OUTPUT_INVALID", "prose accepted");
    const p = buildPiecesPrompt({ language: "bn", title: "My «title»\nhere", count: 7 });
    assert(p.prompt.includes('«My "title" here»') && p.prompt.includes("Bengali script") && p.prompt.includes("1 to 7"), p.prompt);
    assert(buildPiecesPrompt({ language: "en", title: "t", count: 1 }).prompt.includes("Spoken language: English"), "language is a parameter");
  });

  await test("pieces: silent control pieces after piece 3, 9, …; a control with words = shifted answer → AI_OUTPUT_INVALID", async () => {
    const slots = planSlots([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    const shape = slots.map((x) => (x.kind === "control" ? "C" : "p")).join("");
    assert(shape === "pppCppppppCp", shape);
    assert(planSlots([1, 2, 3]).every((x) => x.kind === "piece"), "control placed last in a 3-piece batch");
    const texts = slots.map((x, i) => (x.kind === "control" ? "" : `t${i}`));
    assert(checkControls(slots, texts).join() === "t0,t1,t2,t4,t5,t6,t7,t8,t9,t11", checkControls(slots, texts).join());
    const shifted = texts.map((t, i) => (i === 3 ? "কথা চলে এসেছে" : t));
    assert((await codeOf(Promise.resolve().then(() => checkControls(slots, shifted)))) === "AI_OUTPUT_INVALID", "shift not caught");
    assert(checkControls(slots, texts.map((t, i) => (i === 3 ? "হুম" : t))).length === 10, "a single stray word shouldn't fail it");
  });

  await test("groq reset durations: 18.5s, 7m30s, 1h2m3.5s, 250ms", () => {
    assert(parseGroqDuration("18.5s") === 18.5, "18.5s");
    assert(parseGroqDuration("7m30s") === 450, "7m30s");
    assert(parseGroqDuration("1h2m3.5s") === 3723.5, "1h2m3.5s");
    assert(parseGroqDuration("250ms") === 0.25, "250ms");
    assert(parseGroqDuration(null) === undefined && parseGroqDuration("soon") === undefined, "bad input");
  });

  await test("language check: sample positions; switch only on a unanimous, clear, supported other language", () => {
    assert(JSON.stringify(sampleStarts(20_000)) === "[0]", `20 s → ${JSON.stringify(sampleStarts(20_000))}`);
    assert(JSON.stringify(sampleStarts(120_000)) === "[45]", `2 min → ${JSON.stringify(sampleStarts(120_000))}`);
    assert(JSON.stringify(sampleStarts(3_600_000)) === "[1080,2340]", `1 h → ${JSON.stringify(sampleStarts(3_600_000))}`);
    assert(toSupportedLanguage("Bengali") === "bn" && toSupportedLanguage("English") === "en" && toSupportedLanguage("Hindi") === null, "names");
    const s = (detected: string, usable = true) => ({ detected, words: 20, usable });
    assert(decideLanguage("bn", [s("English"), s("English")]).language === "en", "clear English not switched");
    assert(decideLanguage("bn", [s("English"), s("Bengali")]).switched === false, "switched on disagreement");
    assert(decideLanguage("bn", [s("Hindi"), s("Hindi")]).language === "bn", "switched to unsupported/regional");
    assert(decideLanguage("bn", [s("English", false)]).switched === false, "switched on a music-only sample");
    assert(decideLanguage("en", [s("Bengali")]).language === "bn", "Bangla heard, English picked → bn");
    assert(decideLanguage("bn", [s("Bengali"), s("Bengali")]).switched === false, "confirmed case switched");
  });

  await test("quota period: none → now; same period kept; months later → same day of month", () => {
    const now = new Date("2026-09-28T10:00:00Z");
    assert(currentQuotaPeriodStart(null, now).getTime() === now.getTime(), "no period");
    const p = new Date("2026-09-15T08:00:00Z");
    assert(currentQuotaPeriodStart(p, now).getTime() === p.getTime(), "same period changed");
    const old = new Date("2026-05-20T08:00:00Z");
    assert(currentQuotaPeriodStart(old, now).toISOString() === "2026-09-20T08:00:00.000Z", currentQuotaPeriodStart(old, now).toISOString());
  });

  await test("daily cap: counts up to the cap, then AI_DAILY_CAP_REACHED without counting", async () => {
    const prefix = `smoketest-${Date.now().toString(36)}`;
    const key = capKey("groq:audioSeconds", new Date(), prefix);
    try {
      await reserveDailyCap("groq:audioSeconds", 60, 100, { prefix });
      let code = "";
      try {
        await reserveDailyCap("groq:audioSeconds", 60, 100, { prefix });
      } catch (e) {
        code = e instanceof AppError ? e.code : String(e);
      }
      assert(code === "AI_DAILY_CAP_REACHED", `got ${code || "no error"}`);
      assert(Number(await redis().get(key)) === 60, `counter ${await redis().get(key)}`);
      assert((await redis().ttl(key)) > 0, "no expiry on the counter");
    } finally {
      await redis().del(key);
    }
  });

  // ── database ──────────────────────────────────────────────
  await connectDb({ dbName: TEST_DB, autoIndex: false });
  const db = mongoose.connection.db!;
  for (const c of await db.listCollections().toArray()) await db.dropCollection(c.name);
  for (const M of [User, Video, Transcript, UsageEvent] as unknown as import("mongoose").Model<unknown>[]) await M.createIndexes();

  try {
    await test("charge: once per video; next video adds; a finished month starts over", async () => {
      // The first period starts at sign-up (users.quota.periodStart defaults to creation time).
      const u = await User.create({ clerkId: "user_charge", email: "charge@example.com" });
      const signup = new Date(u.quota!.periodStart!);
      const v1 = new mongoose.Types.ObjectId();
      const v2 = new mongoose.Types.ObjectId();
      const now = new Date(signup.getTime() + 60_000);
      const args = { userId: u._id, provider: "groq", model: "whisper-large-v3", now };
      assert(await chargeMinutes({ ...args, videoId: v1, minutes: 2 }), "first charge refused");
      assert(!(await chargeMinutes({ ...args, videoId: v1, minutes: 2 })), "same video charged twice");
      await chargeMinutes({ ...args, videoId: v2, minutes: 3 });
      let q = (await User.findById(u._id).lean())!.quota!;
      assert(q.minutesUsed === 5 && new Date(q.periodStart!).getTime() === signup.getTime(), JSON.stringify(q));
      const later = new Date(signup.getTime() + 35 * 24 * 3600_000); // a month and a bit later
      await chargeMinutes({ ...args, videoId: new mongoose.Types.ObjectId(), minutes: 4, now: later });
      q = (await User.findById(u._id).lean())!.quota!;
      assert(q.minutesUsed === 4, `after rollover ${q.minutesUsed}`);
      const expected = quotaPeriodEnd(signup); // the next period starts on the same day of the month
      assert(new Date(q.periodStart!).getTime() === expected.getTime(), `period ${new Date(q.periodStart!).toISOString()}`);
      assert((await UsageEvent.countDocuments({ userId: u._id })) === 3, "ledger count");
    });

    // ── real Groq ─────────────────────────────────────────────
    const bn = path.join(FIXTURES, "bn-podcast-120s.ogg");
    const en = path.join(FIXTURES, "en-zoo-19s.ogg");
    if (!existsSync(bn) || !existsSync(en)) {
      results.push({ name: "real Groq checks", ok: false, detail: `fixtures missing in ${FIXTURES}` });
      return;
    }

    const user = await User.create({ clerkId: "user_transcribe", email: "transcribe@example.com" });
    const setup = async (file: string, language: "bn" | "en", durationMs: number) => {
      const videoId = new mongoose.Types.ObjectId();
      const publicId = `smoketest/audio/${String(user._id)}/${String(videoId)}`;
      await cloudinary.uploader.upload(file, {
        resource_type: "video",
        type: "authenticated",
        public_id: publicId,
        asset_folder: `smoketest/audio/${String(user._id)}`,
      });
      const runId = newRunId();
      await Video.create({
        _id: videoId,
        userId: user._id,
        title: "Transcribe smoke",
        language,
        source: { type: "upload" },
        permission: { confirmedAt: new Date(), termsVersion: "2026-09-28" },
        media: { durationMs, hasAudio: true },
        audio: { publicId, format: "ogg", bitrateKbps: 48 },
        status: "queued",
        pipeline: { runId, stages: { ingest: { status: "done", progress: 1 }, audio: { status: "done", progress: 1 } } },
      });
      return { videoId, runId };
    };
    const job = (videoId: unknown, runId: string) =>
      ({ id: pipelineJobId(String(videoId), runId), data: { v: 1, videoId: String(videoId), runId }, attemptsMade: 0, opts: { attempts: 3 } }) as unknown as Job;
    const runToAnalyze = async (videoId: unknown, runId: string) => {
      await processPipelineJob(job(videoId, runId), { scratchRoot: SCRATCH, handlers: UP_TO_TRANSCRIBE }).catch(() => {});
      const v = await Video.findById(videoId).lean().orFail();
      const st = v.pipeline?.stages?.transcribe?.status;
      assert(st === "done", `transcribe ${st} (${v.error?.code}: ${v.error?.message})`);
      assert(v.error?.code === "STAGE_NOT_READY" && v.error.stage === "analyze", `stopped with ${v.error?.code} at ${v.error?.stage}`);
      return v;
    };

    let bnVideo: { videoId: import("mongoose").Types.ObjectId; runId: string } | null = null;
    await test("bangla via Gemini: 2-min podcast → clean Bangla script, piece segments + estimated word times, Cloudinary", async () => {
      bnVideo = await setup(bn, "bn", 120_000);
      const v = await runToAnalyze(bnVideo.videoId, bnVideo.runId);
      const t = await Transcript.findById(v.currentTranscriptId).lean().orFail();
      const text = t.segments.map((s) => s.text).join(" ");
      const letters = [...text].filter((c) => /\p{L}/u.test(c));
      const bengali = letters.filter((c) => /[ঀ-৿]/.test(c)).length / Math.max(letters.length, 1);
      assert(t.language === "bn" && t.script === "Beng" && t.kind === "asr" && t.version === 1, "wrong metadata");
      assert(t.provider === "gemini" && t.model?.startsWith("gemini") && t.wordTiming === "estimated", `engine ${t.provider}/${t.model}/${t.wordTiming} (Gemini busy → Whisper fallback?)`);
      assert(t.segments.every((s) => s.endMs - s.startMs >= 3_000 && s.endMs - s.startMs <= 15_000), "segments aren't 3–15 s pieces");
      assert(/[।?]/.test(text), "no sentence punctuation");
      const rawJson = await readPrivateJson<{ promptVersion?: string; batches?: { controls?: number[] }[] }>(t.raw!.publicId);
      assert(rawJson?.promptVersion === "transcribe-pieces@1" && rawJson.batches?.length === 1, "raw JSON");
      assert((rawJson.batches[0]!.controls?.length ?? 0) >= 1, "no control pieces were sent");
      assert(t.segments.length >= 5 && (t.stats?.wordCount ?? 0) >= 100, `segments ${t.segments.length}, words ${t.stats?.wordCount}`);
      assert(bengali > 0.9, `Bengali-script share ${(bengali * 100).toFixed(1)}%`);
      assert(v.language === "bn" && v.languageCheck?.switched === false, `language check: ${JSON.stringify(v.languageCheck)}`);
      assert(t.segments.every((s, i, a) => Number.isInteger(s.startMs) && s.endMs >= s.startMs && (i === 0 || s.startMs >= a[i - 1]!.startMs)), "segments not ordered integer ms");
      const words = await readPrivateJson<{ words: [number, number, string][] }>(t.words!.publicId);
      assert(words && words.words.length === t.stats?.wordCount && words.words.length === t.words?.count, "words JSON count mismatch");
      const u = (await User.findById(user._id).lean())!;
      assert(u.quota?.minutesUsed === 2, `minutes used ${u.quota?.minutesUsed}`);
    });

    await test("retry after transcription: transcript reused, Groq not called, not charged again", async () => {
      assert(bnVideo, "previous test didn't run");
      const newRun = newRunId();
      await Video.updateOne(
        { _id: bnVideo.videoId },
        {
          $set: { status: "queued", "pipeline.runId": newRun, "pipeline.stages.analyze.status": "pending" },
          $unset: { error: 1 },
        },
      );
      const before = await Transcript.countDocuments({ videoId: bnVideo.videoId });
      await processPipelineJob(job(bnVideo.videoId, newRun), { scratchRoot: SCRATCH, handlers: UP_TO_TRANSCRIBE }).catch(() => {});
      assert((await Transcript.countDocuments({ videoId: bnVideo.videoId })) === before, "second transcript created");
      assert((await UsageEvent.countDocuments({ videoId: bnVideo.videoId })) === 1, "charged twice");
      assert((await User.findById(user._id).lean())!.quota?.minutesUsed === 2, "counter changed");
    });

    await test("Gemini fails (unknown model) → Whisper transcribes instead; the video still finishes", async () => {
      const snap = await getSettingsSnapshot("ai", { fresh: true });
      const actor = { userId: null, email: "smoke@example.com" };
      const broken = { ...snap.value, transcription: { ...snap.value.transcription, gemini: { ...snap.value.transcription.gemini, models: ["gemini-no-such-model"] } } };
      const saved = await updateSettings("ai", broken, { expectedVersion: snap.version, actor });
      try {
        const { videoId, runId } = await setup(bn, "bn", 120_000);
        const v = await runToAnalyze(videoId, runId);
        const t = await Transcript.findById(v.currentTranscriptId).lean().orFail();
        assert(t.provider === "groq" && t.wordTiming === "asr" && t.segments.length >= 5, `engine ${t.provider}/${t.wordTiming}`);
      } finally {
        await updateSettings("ai", snap.value, { expectedVersion: saved.version, actor });
      }
    });

    await test("wrong language picked: English video marked Bangla → detected, switched, English transcript", async () => {
      const { videoId, runId } = await setup(en, "bn", 19_000);
      const v = await runToAnalyze(videoId, runId);
      assert(v.language === "en", `language ${v.language}`);
      assert(v.languageCheck?.switched === true && v.languageCheck.requested === "bn", JSON.stringify(v.languageCheck));
      const t = await Transcript.findById(v.currentTranscriptId).lean().orFail();
      const text = t.segments.map((s) => s.text).join(" ");
      assert(t.script === "Latn" && /elephant/i.test(text), `text: ${text.slice(0, 120)}`);
      assert(t.provider === "groq" && t.wordTiming === "asr", "English should use Whisper");
      assert((await User.findById(user._id).lean())!.quota?.minutesUsed === 5, "19 s should bill 1 minute");
    });
  } finally {
    await cloudinary.api.delete_resources_by_prefix("smoketest/", { resource_type: "video", type: "authenticated" }).catch(() => {});
    await cloudinary.api.delete_resources_by_prefix("smoketest/", { resource_type: "raw", type: "authenticated" }).catch(() => {});
    if (mongoose.connection.db?.databaseName === TEST_DB) await mongoose.connection.db.dropDatabase().catch(() => {});
    await disconnectDb().catch(() => {});
    await runShutdownHooks(() => {});
    await rm(SCRATCH, { recursive: true, force: true });
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
