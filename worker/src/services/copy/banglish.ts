import type { Logger } from "pino";
import type { Types } from "mongoose";
import { z } from "zod";

import { AppError, getSettings, PROMPT_VERSIONS, Transcript, type AiSettings } from "../../shared";
import { reserveDailyCap } from "../ai/daily-caps";
import { generateJson, type JsonRequest, type JsonSchema, type LlmResult, type LlmTarget } from "../ai/llm";
import type { Word } from "../clips/lines";

/**
 * Banglish captions (Step 15, D48): Bangla words written in English letters, word for word, so
 * every caption word keeps its time. Only the words inside clips are transliterated, as they're
 * needed, and remembered on the transcript (`latnWords`, "<startMs>_<endMs>" → spelling; times,
 * not positions, so a different word list can never pick up wrong spellings) — the copy stage
 * does a whole video's clips in one request; a render asks only for words it's missing (a trim).
 */

export const BANGLISH_VERSION = PROMPT_VERSIONS.transliteration.at(-1)!;

/** Words per request: ~3 output tokens each, well inside the output limit. */
const MAX_WORDS_PER_REQUEST = 1_500;
/** Words per run in the prompt: long stretches are split so a slip stays local. */
const MAX_RUN_WORDS = 120;

export type Stretch = { startMs: number; endMs: number };
export type BanglishCall = (target: LlmTarget, request: JsonRequest, signal: AbortSignal | undefined) => Promise<LlmResult>;

// ── pure ─────────────────────────────────────────────────────

/** Indices of the words inside any stretch — the same rule as captions (the word's middle). */
export function wordIndicesIn(words: readonly Word[], stretches: readonly Stretch[]): number[] {
  const out: number[] = [];
  for (const [i, [s, e, text]] of words.entries()) {
    if (!text.trim()) continue;
    const mid = (s + e) / 2;
    if (stretches.some((r) => mid >= r.startMs && mid <= r.endMs)) out.push(i);
  }
  return out;
}

/** Consecutive indices → runs of at most MAX_RUN_WORDS. */
export function toRuns(indices: readonly number[]): number[][] {
  const runs: number[][] = [];
  for (const i of [...indices].sort((a, b) => a - b)) {
    const last = runs.at(-1);
    if (last && i === last.at(-1)! + 1 && last.length < MAX_RUN_WORDS) last.push(i);
    else runs.push([i]);
  }
  return runs;
}

/**
 * The model's words onto the input words. Same count → one to one. Otherwise each input word
 * takes its share of the output in order (captions stay in time; a word may get two or none).
 */
export function alignWords(inputCount: number, output: readonly string[]): string[] {
  if (output.length === inputCount) return [...output];
  return Array.from({ length: inputCount }, (_, i) => {
    const from = Math.floor((i * output.length) / inputCount);
    const to = Math.floor(((i + 1) * output.length) / inputCount);
    return output.slice(from, to).join(" ");
  });
}

const SYSTEM = `You transliterate Bangla speech into Banglish: Bangla written in English (Latin) letters, the way people in Bangladesh type on Facebook and YouTube. You never translate — you write the same Bangla words in English letters.

Rules:
- Exactly one output word for each input word, in the same order, so the n-th output word is the n-th input word. Never merge, split, add or drop words.
- Everyday spelling without accents: আমি → ami, ভালো → valo, খেলা → khela, হয়েছে → hoyeche, কী → ki, বাংলাদেশ → Bangladesh, আমরা → amra.
- English words written in Bangla letters go back to their English spelling: স্ট্রাইকার → striker, টুর্নামেন্ট → tournament, সাপোর্ট → support.
- Names in their usual English spelling (ফাহান → Fahan). Words already in English letters stay as they are.
- Keep punctuation attached to its word; "।" becomes ".".`;

export function buildBanglishPrompt(runs: readonly string[][]): { system: string; prompt: string } {
  const body = runs.map((r, i) => `R${i + 1}: ${JSON.stringify(r)}`).join("\n");
  return {
    system: SYSTEM,
    prompt: `Transliterate every run. Answer with the same run numbers and, for each, exactly as many words as it has.\n\n${body}`,
  };
}

export const BANGLISH_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    runs: {
      type: "array",
      items: {
        type: "object",
        properties: { run: { type: "integer" }, words: { type: "array", items: { type: "string" } } },
        required: ["run", "words"],
        additionalProperties: false,
      },
    },
  },
  required: ["runs"],
  additionalProperties: false,
};

const answerSchema = z.object({ runs: z.array(z.object({ run: z.number().int(), words: z.array(z.string()) })) });

/** Run number → its words. Missing runs make the answer unusable (retried, then the next model). */
export function parseBanglish(text: string, runCount: number): Map<number, string[]> {
  let parsed: z.infer<typeof answerSchema>;
  try {
    parsed = answerSchema.parse(JSON.parse(text));
  } catch (cause) {
    throw new AppError("AI_OUTPUT_INVALID", { cause, details: { reason: "not the runs shape", start: text.slice(0, 120) } });
  }
  const out = new Map(parsed.runs.map((r) => [r.run, r.words.map((w) => w.normalize("NFC").replace(/\s+/g, " ").trim())]));
  for (let n = 1; n <= runCount; n++) {
    if (!out.has(n)) throw new AppError("AI_OUTPUT_INVALID", { details: { reason: `run ${n} missing` } });
  }
  return out;
}

// ── with the database and the AI ─────────────────────────────

/** A word's key in `latnWords`. */
export const latnKey = (w: Word): string => `${w[0]}_${w[1]}`;

function targetsFor(ai: AiSettings): LlmTarget[] {
  return [{ provider: ai.copyWriting.provider, model: ai.copyWriting.model }, ...ai.copyWriting.fallbacks];
}

/**
 * The caption words with Banglish spellings for every word inside `stretches` (other words
 * unchanged). Missing spellings are asked from the AI first and saved on the transcript.
 * Throws the AI's error when it can't be reached — the caller decides what that means.
 */
export async function ensureBanglish(args: {
  transcriptId: Types.ObjectId;
  words: readonly Word[];
  stretches: readonly Stretch[];
  log: Logger;
  signal?: AbortSignal;
  call?: BanglishCall;
}): Promise<{ words: Word[]; asked: number }> {
  const { words, log } = args;
  const doc = await Transcript.findById(args.transcriptId).select({ latnWords: 1 }).lean();
  const known: Record<string, string> = { ...((doc?.latnWords as Record<string, string> | undefined) ?? {}) };
  const missing = wordIndicesIn(words, args.stretches).filter((i) => known[latnKey(words[i]!)] === undefined);

  if (missing.length > 0) {
    const ai = await getSettings("ai");
    const runs = toRuns(missing);
    // Requests of at most MAX_WORDS_PER_REQUEST words.
    const batches: number[][][] = [];
    let size = Infinity;
    for (const run of runs) {
      if (size + run.length > MAX_WORDS_PER_REQUEST) {
        batches.push([]);
        size = 0;
      }
      batches.at(-1)!.push(run);
      size += run.length;
    }
    for (const batch of batches) {
      const texts = batch.map((run) => run.map((i) => words[i]![2].trim()));
      const prompt = buildBanglishPrompt(texts);
      const wordCount = texts.reduce((n, r) => n + r.length, 0);
      const out = await generateJson({
        targets: targetsFor(ai),
        request: {
          ...prompt,
          schemaName: "banglish",
          schema: BANGLISH_SCHEMA,
          temperature: 0,
          noThinking: true,
          maxOutputTokens: Math.min(65_536, 2_000 + wordCount * 12),
          timeoutMs: 2 * 60_000,
        },
        parse: (text) => parseBanglish(text, batch.length),
        signal: args.signal,
        log,
        beforeCall: (t) => reserveDailyCap(`${t.provider}:requests`, 1, t.provider === "gemini" ? ai.dailyCaps.geminiRequests : ai.dailyCaps.groqRequests),
        call: args.call,
      });
      const set: Record<string, string> = {};
      let mismatched = 0;
      for (const [r, run] of batch.entries()) {
        const got = out.value.get(r + 1)!;
        if (got.length !== run.length) mismatched++;
        for (const [k, spelling] of alignWords(run.length, got).entries()) {
          const key = latnKey(words[run[k]!]!);
          known[key] = spelling;
          set[`latnWords.${key}`] = spelling;
        }
      }
      await Transcript.updateOne({ _id: args.transcriptId }, { $set: set });
      log.info({ model: out.target.model, words: wordCount, runs: batch.length, mismatched, version: BANGLISH_VERSION }, "banglish written");
    }
  }

  return {
    words: words.map((w) => {
      const latn = known[latnKey(w)];
      return latn === undefined ? w : ([w[0], w[1], latn] as Word);
    }),
    asked: missing.length,
  };
}
