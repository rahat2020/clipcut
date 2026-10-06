import { reserveDailyCap } from "../../services/ai/daily-caps";
import { measureLoudness } from "../../services/media/loudness";
import { transcriptFilePublicId, uploadPrivateJson } from "../../services/storage/cloudinary";
import { transcribeInPieces } from "../../services/transcription/gemini-pieces";
import { transcribeWithGroq, type RawTranscription } from "../../services/transcription/groq";
import { decideLanguage, SAMPLE_SEC, sampleLanguage, sampleStarts } from "../../services/transcription/language";
import { normalizeTranscription, type StoredSegment, type StoredWord } from "../../services/transcription/normalize";
import {
  AppError,
  billableMinutes,
  getSettings,
  isAppError,
  isDuplicateKeyError,
  Transcript,
  type AiSettings,
  type Language,
} from "../../shared";
import { ensureAudio } from "../audio-file";
import { chargeMinutes } from "../usage";
import type { StageContext, StageHandler } from "./types";

/**
 * Transcribe: the stored audio → transcript version 1 (kind "asr").
 *
 * - Text engine by language (settings.ai.transcription): Bangla → Gemini, piece by piece
 *   (services/transcription/gemini-pieces.ts, D42); others → Groq Whisper. If every Gemini
 *   model fails, Whisper does it instead so the video still finishes.
 * - Segments go in MongoDB; word timestamps and the untouched response go to Cloudinary
 *   as private JSON (docs/SCHEMA.md §3.3).
 * - Idempotent: if this video already has its ASR transcript (a retry after a crash
 *   between saving and marking the stage done), it's reused — Groq isn't called again
 *   and the user isn't charged again.
 * - The video's minutes are charged here, once, when transcription succeeds (D33).
 * - Groq's free tier allows 7,200 audio-seconds per rolling hour. On 429 we wait (the
 *   user sees "waiting for transcription capacity") instead of failing.
 */

const SCRIPT: Record<Language, "Beng" | "Latn"> = { bn: "Beng", en: "Latn" };
/** Longest we sit waiting for Groq capacity before giving the job back as retryable. */
const MAX_WAIT_MS = 30 * 60_000;

export const transcribe: StageHandler = async (ctx) => {
  const { video, run, log } = ctx;
  const durationMs = video.media?.durationMs;
  if (!durationMs) throw new AppError("INTERNAL", { message: "Video length is unknown — the ingest step didn't finish." });

  const ai = await getSettings("ai");
  const model = ai.transcription.model;

  let transcript = await Transcript.findOne({ videoId: video._id, kind: "asr" }).sort({ version: 1 }).lean();
  if (transcript) {
    log.info({ transcriptId: String(transcript._id) }, "transcript already exists — reusing it");
  } else {
    if (!ai.transcription.enabled) {
      throw new AppError("AI_UNAVAILABLE", { message: "Transcription is paused right now. We'll retry automatically." });
    }
    const audioFile = await ensureAudio(ctx);
    await run.reportProgress(0.05);

    const caps = ai.dailyCaps;
    const language = await checkLanguage(ctx, { audioFile, durationMs, model, caps });
    await run.reportProgress(0.1);

    const viaGemini = ai.transcription.gemini.languages.includes(language)
      ? await transcribeWithGemini(ctx, { audioFile, durationMs, language, ai }).catch((err: unknown) => {
          if (run.signal.aborted) throw err;
          log.warn({ err }, "Gemini transcription failed — using Whisper instead");
          return null;
        })
      : null;
    const norm = viaGemini ?? (await transcribeWithWhisper(ctx, { audioFile, durationMs, language, model, caps }));
    if (norm.segments.length === 0) {
      throw new AppError("TRANSCRIPTION_FAILED", {
        message: "We couldn't hear any speech in this video. Clips are found from what people say.",
        retryable: false,
      });
    }

    const userId = String(video.userId);
    const videoId = String(video._id);
    const wordsId = transcriptFilePublicId(userId, videoId, "v1-words");
    const rawId = transcriptFilePublicId(userId, videoId, "v1-raw");
    try {
      await uploadPrivateJson(wordsId, { v: 1, format: "[startMs,endMs,word]", timing: norm.wordTiming, words: norm.words });
      await uploadPrivateJson(rawId, norm.raw);
    } catch (cause) {
      throw new AppError("STORAGE_FAILED", { cause });
    }
    await run.reportProgress(0.95);

    try {
      const created = await Transcript.create({
        videoId: video._id,
        userId: video.userId,
        version: 1,
        kind: "asr",
        language,
        script: SCRIPT[language],
        provider: norm.provider,
        model: norm.model,
        wordTiming: norm.wordTiming,
        durationMs,
        segments: norm.segments,
        words: { publicId: wordsId, count: norm.words.length },
        raw: { publicId: rawId },
        stats: norm.stats,
      });
      transcript = created.toObject();
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      transcript = await Transcript.findOne({ videoId: video._id, version: 1 }).lean();
      if (!transcript) throw err;
    }
  }

  await run.setFields({ currentTranscriptId: transcript._id });
  ctx.video.currentTranscriptId = transcript._id;

  const charged = await chargeMinutes({
    userId: video.userId,
    videoId: video._id,
    minutes: billableMinutes(durationMs),
    provider: transcript.provider ?? "groq",
    model: transcript.model ?? model,
  });
  log.info({ minutes: billableMinutes(durationMs), charged }, charged ? "minutes charged" : "already charged");
};

type Transcribed = {
  provider: "groq" | "gemini";
  model: string;
  wordTiming: "asr" | "estimated";
  segments: StoredSegment[];
  words: StoredWord[];
  stats: { wordCount: number; segmentCount: number; avgLogprob?: number; droppedSegments: number };
  raw: unknown;
};

async function transcribeWithWhisper(
  ctx: StageContext,
  args: { audioFile: string; durationMs: number; language: Language; model: string; caps: AiSettings["dailyCaps"] },
): Promise<Transcribed> {
  const { run, log } = ctx;
  const { audioFile, durationMs, language, model, caps } = args;
  await reserveDailyCap("groq:requests", 1, caps.groqRequests);
  await reserveDailyCap("groq:audioSeconds", durationMs / 1000, caps.groqAudioMinutes * 60);

  const raw = await callWithCapacityWait(ctx, () => transcribeWithGroq({ file: audioFile, language, model, signal: run.signal }));
  await run.reportProgress(0.8);

  const norm = normalizeTranscription(raw.result, durationMs);
  log.info({ model, latencyMs: raw.latencyMs, ...norm.stats, remainingAudioSeconds: raw.rateLimits.remainingAudioSeconds }, "transcribed");
  return { provider: "groq", model, wordTiming: "asr", ...norm, raw: raw.result };
}

/** Gemini writes the text of short pieces cut at pauses; the pieces give the timing (D42). */
async function transcribeWithGemini(
  ctx: StageContext,
  args: { audioFile: string; durationMs: number; language: Language; ai: AiSettings },
): Promise<Transcribed> {
  const { run, log, video, scratchDir } = ctx;
  const cfg = args.ai.transcription.gemini;
  const loudness = await measureLoudness({ file: args.audioFile, durationMs: args.durationMs, signal: run.signal });
  const out = await transcribeInPieces({
    file: args.audioFile,
    durationMs: args.durationMs,
    loudness,
    language: args.language,
    title: video.title ?? "",
    models: cfg.models,
    batchMinutes: cfg.batchMinutes,
    workDir: scratchDir,
    signal: run.signal,
    log,
    beforeCall: () => reserveDailyCap("gemini:requests", 1, args.ai.dailyCaps.geminiRequests),
    onProgress: (f) => void run.reportProgress(0.1 + 0.75 * f).catch(() => {}),
  });
  log.info({ model: out.model, ...out.stats, batches: out.raw.batches.length }, "transcribed with Gemini");
  return { provider: "gemini", wordTiming: "estimated", ...out };
}

/**
 * Checks the user's language choice on 1–2 short samples (language.ts) and returns the
 * language to transcribe in. When the audio is clearly the other supported language, the
 * video's `language` is corrected and the page tells the user. Best effort: if the check
 * itself fails (rate limit, network) we keep the user's choice rather than fail the video.
 */
async function checkLanguage(
  ctx: StageContext,
  args: { audioFile: string; durationMs: number; model: string; caps: { groqRequests: number; groqAudioMinutes: number } },
): Promise<Language> {
  const { video, run, log, scratchDir } = ctx;
  const requested = video.language;
  const starts = sampleStarts(args.durationMs);
  try {
    await reserveDailyCap("groq:requests", starts.length, args.caps.groqRequests);
    await reserveDailyCap("groq:audioSeconds", starts.length * SAMPLE_SEC, args.caps.groqAudioMinutes * 60);
    const samples = await sampleLanguage({
      audioFile: args.audioFile,
      durationMs: args.durationMs,
      workDir: scratchDir,
      model: args.model,
      signal: run.signal,
    });
    const decision = decideLanguage(requested, samples);
    log.info({ requested, ...decision, samples }, decision.switched ? "language corrected" : "language confirmed");
    await run.setFields({
      ...(decision.switched ? { language: decision.language } : {}),
      languageCheck: {
        requested,
        detected: decision.detected.map((d) => d ?? "unknown"),
        switched: decision.switched,
        at: new Date(),
      },
    });
    ctx.video.language = decision.language;
    return decision.language;
  } catch (err) {
    if (run.signal.aborted || (isAppError(err) && err.code === "AI_DAILY_CAP_REACHED")) throw err;
    log.warn({ err }, "language check failed — keeping the user's choice");
    return requested;
  }
}

/**
 * Runs `call`; on Groq's rate limit (429) waits for the time Groq asks (default 60 s),
 * showing a countdown, and tries again — up to MAX_WAIT_MS in total. The heartbeat keeps
 * running while we wait, so the stuck-job sweep leaves the run alone.
 */
async function callWithCapacityWait<T>(
  ctx: StageContext,
  call: () => Promise<T & { result: RawTranscription }>,
): Promise<T & { result: RawTranscription }> {
  const { run, log } = ctx;
  const started = Date.now();
  for (;;) {
    try {
      const out = await call();
      await run.clearActivity();
      return out;
    } catch (err) {
      if (!isAppError(err) || err.code !== "AI_UNAVAILABLE") throw err;
      const retryAfter = Number(err.details?.retryAfterSec ?? err.details?.resetAudioSec);
      const waitSec = Math.min(Math.max(Number.isFinite(retryAfter) ? retryAfter : 60, 5), 15 * 60);
      if (Date.now() - started + waitSec * 1000 > MAX_WAIT_MS) throw err;

      log.warn({ waitSec }, "Groq rate limit — waiting for capacity");
      // Count down in steps so the page's "about N min" stays honest.
      for (let left = waitSec; left > 0; left -= 15) {
        await run.reportActivity(
          { kind: "waiting_transcription", doneBytes: 0, totalBytes: null, bytesPerSec: 0, etaSec: left },
          { force: true },
        );
        await sleep(Math.min(left, 15) * 1000, run.signal);
      }
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}
