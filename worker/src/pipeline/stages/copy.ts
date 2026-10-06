import { loadCaptionWords } from "../../renders/produce";
import { reserveDailyCap } from "../../services/ai/daily-caps";
import { generateJson, type JsonRequest, type LlmResult, type LlmTarget } from "../../services/ai/llm";
import { ensureBanglish } from "../../services/copy/banglish";
import { buildCopyPrompt, parseCopy } from "../../services/copy/prompt";
import { captionScriptFor, Clip, getSettings, isAppError, Transcript, Video, visibleClipsFilter } from "../../shared";
import { RunLostError } from "../run";
import type { StageContext, StageHandler } from "./types";

/**
 * Copy ("Writing titles & hooks", Step 15 / D48): one AI request writes the post text — title,
 * hook, description, hashtags — for every clip the video shows that doesn't have it yet in the
 * video's letters (Bangla script, Banglish, or English), or that the user asked to write again.
 * For a Bangla video with Banglish captions it also spells the clips' words in Banglish (one
 * more request), so its renders don't each have to ask.
 *
 * Nice to have, never a reason to fail the video: when the AI can't be reached the stage ends
 * as "skipped" and the page offers "Write post text".
 */

const MAX_OUTPUT_TOKENS = 16_384;
const CALL_TIMEOUT_MS = 2 * 60_000;

export type CopyDeps = { call?: (target: LlmTarget, request: JsonRequest, signal: AbortSignal | undefined) => Promise<LlmResult> };

export const copy: StageHandler = (ctx) => runCopy(ctx, {});

export function makeCopy(deps: CopyDeps): StageHandler {
  return (ctx) => runCopy(ctx, deps);
}

async function runCopy(ctx: StageContext, deps: CopyDeps): Promise<void | "skipped"> {
  const { video, run, log } = ctx;
  // Fresh: the user may have switched letters, and analyze (earlier in this job) sets the run.
  const fresh = await Video.findById(video._id).select({ currentAnalysisRunId: 1, options: 1, title: 1, language: 1, currentTranscriptId: 1 }).lean();
  if (!fresh) return "skipped";
  const script = captionScriptFor({ language: fresh.language, captionScript: fresh.options?.captionScript });
  const clips = await Clip.find(visibleClipsFilter(fresh))
    .select({ rank: 1, startMs: 1, endMs: 1, durationMs: 1, transcriptText: 1, ai: 1, copy: 1, copyRedoAt: 1, coverRedoAt: 1, keptAt: 1 })
    .sort({ rank: 1 })
    .lean();
  if (clips.length === 0) return "skipped";

  const ai = await getSettings("ai");
  const cfg = ai.copyWriting;
  let wrote = 0;
  let failed = false;
  const needsText = (c: (typeof clips)[number]) => !c.copy?.title || !!c.copyRedoAt || c.copy.script !== script || c.copy.language !== fresh.language;
  // "Suggest words" (Step 15.6) asks for the cover words only: the clip's other text stays as it is.
  const todo = clips.filter((c) => needsText(c) || c.coverRedoAt);

  if (todo.length > 0 && cfg.enabled) {
    await run.reportProgress(0.1);
    try {
      const { version, prompt } = buildCopyPrompt(cfg.promptVersion, {
        title: fresh.title,
        language: fresh.language,
        script,
        clips: todo.map((c, i) => ({
          n: i + 1,
          text: c.transcriptText ?? "",
          momentType: c.ai?.momentType ?? "other",
          reason: c.ai?.reason ?? "",
          durationMs: c.durationMs,
        })),
      });
      const out = await generateJson({
        targets: [{ provider: cfg.provider, model: cfg.model }, ...cfg.fallbacks],
        request: { ...prompt, schemaName: "post_copy", temperature: cfg.temperature, maxOutputTokens: MAX_OUTPUT_TOKENS, timeoutMs: CALL_TIMEOUT_MS },
        parse: parseCopy,
        signal: run.signal,
        log,
        beforeCall: (t) => reserveDailyCap(`${t.provider}:requests`, 1, t.provider === "gemini" ? ai.dailyCaps.geminiRequests : ai.dailyCaps.groqRequests),
        call: deps.call,
      });
      const now = new Date();
      for (const [i, clip] of todo.entries()) {
        const text = out.value.get(i + 1);
        if (!text) continue;
        const set = needsText(clip)
          ? { copy: { ...text, language: fresh.language, script, model: out.target.model, promptVersion: version, writtenAt: now } }
          : { "copy.coverText": text.coverText, "copy.coverOptions": text.coverOptions };
        await Clip.updateOne({ _id: clip._id }, { $set: set, $unset: { copyRedoAt: 1, coverRedoAt: 1 } });
        wrote++;
      }
      log.info({ model: out.target.model, asked: todo.length, wrote, usage: out.result.usage, script }, "post text written");
    } catch (err) {
      if (err instanceof RunLostError || run.signal.aborted) throw err;
      failed = true;
      log.warn({ code: isAppError(err) ? err.code : "INTERNAL", err }, "couldn't write post text — the page offers to try again");
    }
  }
  await run.reportProgress(0.6);

  // Banglish captions: spell the clips' words now, in one request, so renders find them ready.
  if (script === "Latn" && fresh.language === "bn" && fresh.currentTranscriptId) {
    try {
      const transcript = await Transcript.findOne({ _id: fresh.currentTranscriptId, videoId: fresh._id }).select({ segments: 1, words: 1 }).lean();
      if (transcript) {
        const words = await loadCaptionWords(transcript, log);
        const { asked } = await ensureBanglish({ transcriptId: transcript._id, words, stretches: clips, log, signal: run.signal, call: deps.call });
        log.info({ asked }, "banglish ready for the clips");
      }
    } catch (err) {
      if (err instanceof RunLostError || run.signal.aborted) throw err;
      log.warn({ code: isAppError(err) ? err.code : "INTERNAL", err }, "couldn't write banglish now — renders will ask again");
    }
  }

  if (failed && wrote === 0) return "skipped";
}
