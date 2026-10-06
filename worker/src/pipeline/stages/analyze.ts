import type { Types } from "mongoose";

import { reserveDailyCap } from "../../services/ai/daily-caps";
import { generateJson, type JsonRequest, type LlmResult, type LlmTarget } from "../../services/ai/llm";
import { buildLines, lineRangesFor, type Word } from "../../services/clips/lines";
import { resolveMoments, type ResolvedMoment } from "../../services/clips/moments";
import { buildClipSelectPrompt, CLIP_SELECT_SCHEMA, parseClipSelection } from "../../services/clips/prompt";
import { buildSnapTrack, SNAP_RULES, SNAP_VERSION, type SnapTrack } from "../../services/clips/snap";
import { measureLoudness, type Loudness } from "../../services/media/loudness";
import { analysisFilePublicId, readPrivateJson, uploadPrivateJson } from "../../services/storage/cloudinary";
import {
  AnalysisRun,
  AppError,
  Clip,
  getSettings,
  isAppError,
  isClipSelectPromptVersion,
  LATEST_CLIP_SELECT_PROMPT,
  Transcript,
  visibleClipsFilter,
  type AiSettings,
} from "../../shared";
import { ensureAudio } from "../audio-file";
import { limitsFor } from "../limits";
import type { StageContext, StageHandler } from "./types";

/**
 * Analyze ("Finding moments"): the WHOLE transcript goes to the clip-selection model in
 * one call (no chunking — priority #1 in CLAUDE.md), which answers with line ranges;
 * code turns them into clips (services/clips/moments.ts) and snaps their cuts to clean
 * boundaries using word timestamps + the audio's loudness (services/clips/snap.ts, Step 10).
 *
 * Records: one analysis_runs row (model, prompt version, tokens, how many proposals
 * survived), the prompt + raw answer in Cloudinary, and one clips row per moment.
 * Idempotent: the video's current run is reused when it finished for this transcript;
 * rows left by a crashed attempt are cleared first.
 *
 * Admin re-run (`pipeline.analyzeWith`): always a fresh "regenerate" run with exactly that
 * model and prompt — no fallback, so a comparison never silently uses another model.
 *
 * User "Find new clips" (`clipRequest` pending, Step 14 / D47): a fresh run for the focus in
 * `options`. Stretches the user has already dealt with are taken (told to the model and
 * enforced in code): approved clips and every clip ever rejected, plus every shown clip when
 * the focus didn't change ("show me others"). On success approved clips are kept next to the new set;
 * a run with no moments leaves the current clips as they were.
 */

/** Ask for a few more than we keep: some proposals fail the length/overlap checks. */
const EXTRA_ASK = 0.3;
/** Thinking tokens count toward this on Gemini 2.5+. */
const MAX_OUTPUT_TOKENS = 16_384;
const CALL_TIMEOUT_MS = 3 * 60_000;

/** Tests replace the AI (scripts/clips-smoke-test.ts); production uses the real providers. */
export type AnalyzeDeps = { call?: (target: LlmTarget, request: JsonRequest, signal: AbortSignal | undefined) => Promise<LlmResult> };

export const analyze: StageHandler = (ctx) => runAnalyze(ctx, {});

export function makeAnalyze(deps: AnalyzeDeps): StageHandler {
  return (ctx) => runAnalyze(ctx, deps);
}

async function runAnalyze(ctx: StageContext, deps: AnalyzeDeps): Promise<void> {
  const { video, run, log } = ctx;
  const videoId = video._id;
  if (!video.currentTranscriptId) throw new AppError("INTERNAL", { message: "The transcript step didn't finish." });

  const rerun = video.pipeline?.analyzeWith ?? null;
  const request = !rerun && video.clipRequest?.status === "pending" ? video.clipRequest : null;
  const reused =
    !rerun && !request && video.currentAnalysisRunId
      ? await AnalysisRun.findOne({
          _id: video.currentAnalysisRunId,
          videoId,
          transcriptId: video.currentTranscriptId,
          status: "done",
        }).lean()
      : null;
  if (reused) {
    const accepted = reused.result?.accepted ?? 0;
    log.info({ analysisRunId: String(reused._id), accepted }, "clip selection already done — reusing it");
    await run.setFields({ currentAnalysisRunId: reused._id, "counts.clips": accepted });
    ctx.video.currentAnalysisRunId = reused._id; // later stages in this job (render) read it from here
    if (accepted === 0) throw new AppError("NO_MOMENTS_FOUND");
    return;
  }
  await clearCrashedRuns(videoId);

  const ai = await getSettings("ai");
  const cfg = ai.clipSelection;
  if (!cfg.enabled && !rerun) {
    throw new AppError("AI_UNAVAILABLE", { message: "Finding moments is paused right now. We'll retry automatically." });
  }

  const transcript = await Transcript.findOne({ _id: video.currentTranscriptId, videoId }).lean();
  if (!transcript) throw new AppError("INTERNAL", { message: "The transcript is missing." });
  // Word timestamps make finer lines; without them (read failed) whole segments still work.
  const words = transcript.words?.publicId
    ? await readPrivateJson<{ words?: Word[] }>(transcript.words.publicId).catch((err: unknown) => {
        log.warn({ err }, "couldn't read word timestamps — using whole segments");
        return null;
      })
    : null;
  const lines = buildLines(transcript.segments, words?.words ?? null);
  if (lines.length === 0) throw new AppError("NO_MOMENTS_FOUND");

  const { limits } = await limitsFor(video);
  const minClipMs = video.options?.minClipMs ?? 15_000;
  const maxClipMs = video.options?.maxClipMs ?? 90_000;
  const intent = video.options?.intent ?? "best";
  const query = video.options?.customQuery ?? null;
  const taken = request ? await takenStretches(video, intent, query) : { clips: [], approved: 0 };
  // Approved clips stay on the page, so they count toward the plan's clips per video.
  const count = Math.max(1, Math.min(video.options?.targetClipCount ?? 10, limits.maxClipsPerVideo) - taken.approved);
  const wanted = rerun?.promptVersion ?? cfg.promptVersion;
  const promptVersion = isClipSelectPromptVersion(wanted) ? wanted : LATEST_CLIP_SELECT_PROMPT;
  if (promptVersion !== wanted) log.warn({ configured: wanted, using: promptVersion }, "unknown prompt version");

  const prompt = buildClipSelectPrompt(promptVersion, {
    title: video.title,
    language: transcript.language,
    durationMs: video.media?.durationMs ?? lines.at(-1)!.endMs,
    lines,
    intent,
    query,
    askFor: Math.ceil(count * (1 + EXTRA_ASK)),
    minClipMs,
    maxClipMs,
    avoid: lineRangesFor(lines, taken.clips),
  });
  const targets: LlmTarget[] = rerun
    ? [{ provider: rerun.provider, model: rerun.model }]
    : [{ provider: cfg.provider, model: cfg.model }, ...cfg.fallbacks];
  if (rerun) log.info({ ...targets[0], promptVersion, requestedBy: rerun.requestedBy }, "admin re-run of clip selection");
  if (request) log.info({ intent, query, taken: taken.clips.length, count }, "user asked for new clips");

  const analysisRun = await AnalysisRun.create({
    videoId,
    userId: video.userId,
    transcriptId: transcript._id,
    kind: rerun ? "regenerate" : request ? (intent === "custom" ? "search" : "regenerate") : "initial",
    input: {
      intent,
      query: query ?? undefined,
      targetClipCount: count,
      minClipMs,
      maxClipMs,
      ...(taken.clips.length ? { excludeClipIds: taken.clips.map((c) => c._id) } : {}),
    },
    ai: { ...targets[0]!, promptVersion, temperature: cfg.temperature },
    status: "running",
  });
  const analysisRunId = analysisRun._id;
  await run.reportProgress(0.1);
  // Measured while the model thinks. Best effort: without it, cuts use timestamps only.
  const durationMs = video.media?.durationMs ?? lines.at(-1)!.endMs;
  const loudnessPromise = loadLoudness(ctx, durationMs);

  const stopTicker = progressTicker(run.reportProgress.bind(run), lines.length);
  try {
    const out = await generateJson({
      targets,
      request: {
        ...prompt,
        schemaName: "clip_selection",
        schema: CLIP_SELECT_SCHEMA,
        temperature: cfg.temperature,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        timeoutMs: CALL_TIMEOUT_MS,
      },
      parse: parseClipSelection,
      signal: run.signal,
      log,
      beforeCall: (t) => reserveDailyCap(`${t.provider}:requests`, 1, capFor(ai, t)),
      call: deps.call,
    });
    stopTicker();

    const track = buildSnapTrack({ segments: transcript.segments, words: words?.words ?? null, loudness: await loudnessPromise, durationMs });
    const { moments, stats } = resolveMoments(out.value.moments, lines, { minClipMs, maxClipMs, count, track, taken: taken.clips });
    log.info(
      {
        provider: out.target.provider,
        model: out.target.model,
        latencyMs: out.result.latencyMs,
        usage: out.result.usage,
        lines: lines.length,
        malformed: out.value.malformed,
        snapBasis: track.basis,
        ...stats,
      },
      "moments picked",
    );

    const rawId = analysisFilePublicId(String(video.userId), String(videoId), String(analysisRunId));
    try {
      await uploadPrivateJson(rawId, {
        v: 1,
        promptVersion,
        target: out.target,
        attempts: out.attempts,
        request: prompt,
        response: out.result.raw,
        resolved: { stats, moments },
        snap: { version: SNAP_VERSION, basis: track.basis, rules: SNAP_RULES, quietDb: track.loudness?.quietDb ?? null },
      });
    } catch (cause) {
      throw new AppError("STORAGE_FAILED", { cause });
    }
    await run.reportProgress(0.9);

    if (moments.length > 0) await Clip.insertMany(moments.map((m) => toClipDoc(m, video, analysisRunId, track)));
    await AnalysisRun.updateOne(
      { _id: analysisRunId },
      {
        $set: {
          status: "done",
          "ai.provider": out.target.provider,
          "ai.model": out.target.model,
          usage: {
            inputTokens: out.result.usage.inputTokens,
            outputTokens: (out.result.usage.outputTokens ?? 0) + (out.result.usage.thinkingTokens ?? 0),
            latencyMs: out.result.latencyMs,
          },
          result: { candidates: stats.proposed, accepted: moments.length },
          rawResponse: { publicId: rawId },
          finishedAt: new Date(),
        },
      },
    );
    if (request) {
      const ended = { "clipRequest.finishedAt": new Date(), "clipRequest.analysisRunId": analysisRunId };
      if (moments.length === 0 && video.currentAnalysisRunId) {
        // Nothing new (e.g. a search with no match): the current clips stay as they were.
        await run.setFields({ ...ended, "clipRequest.status": "no_moments" });
        log.info("no new moments — current clips unchanged");
        return;
      }
      const kept = moments.length > 0 ? await keepApproved(video) : 0;
      await run.setFields({
        ...ended,
        "clipRequest.status": moments.length > 0 ? "done" : "no_moments",
        currentAnalysisRunId: analysisRunId,
        "counts.clips": moments.length + kept,
      });
    } else {
      await run.setFields({ currentAnalysisRunId: analysisRunId, "counts.clips": moments.length });
    }
    ctx.video.currentAnalysisRunId = analysisRunId; // later stages in this job (render) read it from here
    if (rerun) await run.unsetFields(["pipeline.analyzeWith"]);
    if (moments.length === 0) throw new AppError("NO_MOMENTS_FOUND");
  } catch (err) {
    stopTicker();
    await loudnessPromise; // never rejects; don't leave ffmpeg running past the stage
    if (!(isAppError(err) && err.code === "NO_MOMENTS_FOUND")) {
      await AnalysisRun.updateOne(
        { _id: analysisRunId, status: "running" },
        {
          $set: {
            status: "failed",
            error: { code: isAppError(err) ? err.code : "INTERNAL", message: err instanceof Error ? err.message.slice(0, 300) : undefined },
            finishedAt: new Date(),
          },
        },
      ).catch((e: unknown) => log.warn({ err: e }, "couldn't mark the analysis run failed"));
    }
    throw err;
  }
}

type TakenClip = { _id: Types.ObjectId; startMs: number; endMs: number };
type VideoRef = { _id: Types.ObjectId; currentAnalysisRunId?: Types.ObjectId | null };

/**
 * Stretches a "Find new clips" run must not repeat: approved clips, and every clip the user
 * ever rejected on this video (from any earlier set); with the same focus as the current set,
 * every clip shown too (the user wants different ones). With a new focus, unreviewed clips may
 * come back — they may be what the new focus is after.
 */
async function takenStretches(video: VideoRef, intent: string, query: string | null): Promise<{ clips: TakenClip[]; approved: number }> {
  const fields = { startMs: 1, endMs: 1, status: 1 } as const;
  const [shown, rejected, current] = await Promise.all([
    Clip.find(visibleClipsFilter(video)).select(fields).lean(),
    Clip.find({ videoId: video._id, deletedAt: null, status: "rejected" }).select(fields).lean(),
    video.currentAnalysisRunId ? AnalysisRun.findOne({ _id: video.currentAnalysisRunId, videoId: video._id }).select({ input: 1 }).lean() : null,
  ]);
  const sameFocus = !!current && current.input?.intent === intent && (current.input?.query ?? null) === query;
  const taken = new Map<string, TakenClip>();
  for (const c of [...shown.filter((c) => sameFocus || c.status === "approved"), ...rejected]) {
    taken.set(String(c._id), { _id: c._id, startMs: c.startMs, endMs: c.endMs });
  }
  return { clips: [...taken.values()], approved: shown.filter((c) => c.status === "approved").length };
}

/**
 * The new set is about to replace the current one: clips approved right now stay (`keptAt`);
 * earlier kept clips that are no longer approved leave. Read at the end, not the start — the
 * user may approve a clip while the model thinks. Returns how many are kept.
 */
async function keepApproved(video: VideoRef): Promise<number> {
  const approved = await Clip.find({ ...visibleClipsFilter(video), status: "approved" }).select({ _id: 1 }).lean();
  const ids = approved.map((c) => c._id);
  const now = new Date();
  await Clip.updateMany({ _id: { $in: ids }, keptAt: null }, { $set: { keptAt: now } });
  await Clip.updateMany({ videoId: video._id, keptAt: { $ne: null }, _id: { $nin: ids } }, { $unset: { keptAt: 1 } });
  return ids.length;
}

function capFor(ai: AiSettings, target: LlmTarget): number {
  return target.provider === "gemini" ? ai.dailyCaps.geminiRequests : ai.dailyCaps.groqRequests;
}

/** Loudness of the stored audio, or null (logged) when it can't be had. Never throws. */
async function loadLoudness(ctx: StageContext, durationMs: number): Promise<Loudness | null> {
  try {
    const file = await ensureAudio(ctx);
    return await measureLoudness({ file, durationMs, signal: ctx.run.signal });
  } catch (err) {
    if (!ctx.run.signal.aborted) ctx.log.warn({ err }, "couldn't measure the audio — snapping with timestamps only");
    return null;
  }
}

function toClipDoc(m: ResolvedMoment, video: { _id: unknown; userId: unknown }, analysisRunId: unknown, track: SnapTrack) {
  return {
    videoId: video._id,
    userId: video.userId,
    analysisRunId,
    origin: "ai" as const,
    rank: m.rank,
    startMs: m.startMs,
    endMs: m.endMs,
    durationMs: m.durationMs,
    ai: { rawStartMs: m.rawStartMs, rawEndMs: m.rawEndMs, score: m.score, momentType: m.momentType, reason: m.reason.slice(0, 1000) },
    snap: m.snap
      ? { version: SNAP_VERSION, basis: track.basis, startRule: m.snap.startRule, endRule: m.snap.endRule }
      : { version: "lines", basis: "lines", startRule: m.fit.start, endRule: m.fit.end },
    transcriptText: m.transcriptText,
    status: "suggested" as const,
  };
}

/**
 * A retry after a crash may find a run still marked "running" with some of its
 * clips saved. Nothing points at them yet (currentAnalysisRunId is set last), so clear them.
 */
async function clearCrashedRuns(videoId: Types.ObjectId): Promise<void> {
  const stale = await AnalysisRun.find({ videoId, status: "running" }).select({ _id: 1 }).lean();
  if (stale.length === 0) return;
  const ids = stale.map((r) => r._id);
  await Clip.deleteMany({ analysisRunId: { $in: ids } });
  await AnalysisRun.updateMany(
    { _id: { $in: ids }, status: "running" },
    { $set: { status: "failed", error: { code: "ABANDONED", message: "The worker stopped mid-run." }, finishedAt: new Date() } },
  );
}

/**
 * The model call takes ~10–60 s with no progress of its own. Move the bar smoothly toward
 * 85 % on a curve sized by transcript length, so the page doesn't look frozen.
 */
function progressTicker(report: (fraction: number) => Promise<void>, lineCount: number): () => void {
  const expectedMs = 15_000 + lineCount * 60;
  const started = Date.now();
  const timer = setInterval(() => {
    const t = (Date.now() - started) / expectedMs;
    report(0.1 + 0.75 * (1 - Math.exp(-2 * t))).catch(() => {});
  }, 3_000);
  timer.unref();
  return () => clearInterval(timer);
}
