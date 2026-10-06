import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "pino";

import { env } from "../../config/env";
import { runTool } from "../../lib/exec";
import { AppError, normalizeText, type Language } from "../../shared";
import { generateJson, type AttemptLog, type LlmTarget } from "../ai/llm";
import type { Loudness, Span } from "../media/loudness";
import { chunkAudio, estimateWordTimes } from "./chunks";
import type { StoredSegment, StoredWord } from "./normalize";

/**
 * Transcription TEXT from Gemini, TIMING from us (D42).
 *
 * Whisper's Bangla was mostly nonsense on real videos; Gemini writes clean Bangla but gives
 * no usable timestamps. So the audio is cut into 3–15 s pieces at pauses (chunks.ts), the
 * pieces go to Gemini in batches (~10 min each, one labelled audio part per piece), and
 * Gemini answers the text of every piece. A piece's start/end are exact (we cut it); word
 * times inside it are spread over its speech.
 *
 * Guard against shifted answers: a weaker model can lose track of the pieces and write a
 * piece's words into a later one (gemini-3.5-flash-lite did, 2026-09-30) — every piece is
 * still "answered", but captions would show at the wrong time. So each batch also carries
 * silent CONTROL pieces (1.5 s, one after every 6th piece, first after the 3rd). A control
 * that comes back with words means the answer is shifted → unusable → retried, then the
 * next model.
 *
 * Prompts are versioned like the clip prompts — never change a released version's wording.
 */

export const PIECES_PROMPT_VERSION = "transcribe-pieces@1";

const LANGUAGE_RULES: Record<Language, { name: string; script: string }> = {
  bn: {
    name: "Bangla (Bengali), possibly a regional dialect, with English words mixed in",
    script:
      "in Bengali script with correct spelling. English words the speaker uses are written in Bengali script too (স্ট্রাইকার, ফুটবল); only acronyms and brand names stay in Latin letters (SAFF, GBK)",
  },
  en: { name: "English", script: "in English with correct spelling" },
};

/** Batches sent at the same time. Free tier allows ~10 requests a minute per model. */
const BATCH_CONCURRENCY = 2;
/** Typical time for one batch; only drives the progress bar while it's in flight. */
const EXPECTED_BATCH_MS = 60_000;

/** A silent control piece goes after piece 3, 9, 15, … of each batch (never last). */
export const CONTROL_EVERY = 6;
const CONTROL_FIRST_AFTER = 3;
const CONTROL_MS = 1_500;

type Slot = { kind: "piece"; index: number } | { kind: "control" };

/** The batch's pieces in order, with control pieces placed between them. Pure. */
export function planSlots(pieceIndexes: readonly number[]): Slot[] {
  const slots: Slot[] = [];
  pieceIndexes.forEach((index, k) => {
    slots.push({ kind: "piece", index });
    const n = k + 1;
    if (n < pieceIndexes.length && n >= CONTROL_FIRST_AFTER && (n - CONTROL_FIRST_AFTER) % CONTROL_EVERY === 0) slots.push({ kind: "control" });
  });
  return slots;
}

/**
 * Texts per slot → texts per piece. A control piece with words (2+) means the answer is
 * shifted: AI_OUTPUT_INVALID, so it's retried / the next model tries.
 */
export function checkControls(slots: readonly Slot[], texts: readonly string[]): string[] {
  const leaked = slots.flatMap((slot, i) => (slot.kind === "control" && texts[i]!.split(" ").filter(Boolean).length >= 2 ? [i + 1] : []));
  if (leaked.length > 0) throw new AppError("AI_OUTPUT_INVALID", { details: { why: "control piece got words — answer shifted", slots: leaked } });
  return slots.flatMap((slot, i) => (slot.kind === "piece" ? [texts[i]!] : []));
}

export const PIECES_SCHEMA = {
  type: "object",
  properties: {
    pieces: {
      type: "array",
      items: {
        type: "object",
        properties: { piece: { type: "integer" }, text: { type: "string" } },
        required: ["piece", "text"],
      },
    },
  },
  required: ["pieces"],
};

export function buildPiecesPrompt(args: { language: Language; title: string; count: number }): { system: string; prompt: string } {
  const rules = LANGUAGE_RULES[args.language];
  // The title is user/YouTube text: quoted as data, on one line, «» swapped out.
  const title = args.title.replace(/[«»]/g, '"').replace(/\s+/g, " ").trim().slice(0, 200);
  return {
    system: "You transcribe speech exactly as it is spoken. You never translate, summarise, or add words.",
    prompt: [
      `Above are ${args.count} consecutive pieces of one video's audio, in order, labelled Piece 1 to Piece ${args.count}.`,
      `Video title (only a hint for names; it may be wrong): «${title}»`,
      `Spoken language: ${rules.name}.`,
      "",
      "For EVERY piece, write exactly what is said in it:",
      "- verbatim, keeping the speaker's own words and dialect; do not translate, summarise, correct grammar or add words",
      `- ${rules.script}`,
      "- with punctuation: । ? ! at sentence ends (. ? ! for English), commas where the speaker pauses",
      "- a word cut between two pieces goes with the piece that holds most of it",
      "- a piece with no speech (music, noise, silence) gets an empty text; never write labels like [music]",
      `Answer with one entry per piece, piece numbers 1 to ${args.count}.`,
    ].join("\n"),
  };
}

/** The answer → one text per piece, in order. Missing pieces → AI_OUTPUT_INVALID (retried). */
export function parsePieces(text: string, count: number): string[] {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (cause) {
    throw new AppError("AI_OUTPUT_INVALID", { cause, details: { why: "not JSON" } });
  }
  const list = (body as { pieces?: unknown })?.pieces;
  if (!Array.isArray(list)) throw new AppError("AI_OUTPUT_INVALID", { details: { why: "no pieces list" } });
  const texts = new Map<number, string>();
  for (const item of list) {
    const n = (item as { piece?: unknown })?.piece;
    const t = (item as { text?: unknown })?.text;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > count || typeof t !== "string") continue;
    texts.set(n, (texts.get(n) ? `${texts.get(n)} ` : "") + t);
  }
  const missing = Array.from({ length: count }, (_, i) => i + 1).filter((n) => !texts.has(n));
  if (missing.length > 0) throw new AppError("AI_OUTPUT_INVALID", { details: { why: "pieces missing", missing: missing.slice(0, 20) } });
  return Array.from({ length: count }, (_, i) => cleanPieceText(texts.get(i + 1)!));
}

/** NFC (keeps ZWJ for conjuncts), no [labels], single spaces. */
export function cleanPieceText(text: string): string {
  return normalizeText(text)
    .replace(/\[[^\]]{0,40}\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type PiecesBatchLog = {
  firstPiece: number;
  count: number;
  /** Where the silent control pieces were (1-based piece labels in the request). */
  controls: number[];
  target: LlmTarget;
  attempts: AttemptLog[];
  latencyMs: number;
  usage: unknown;
  answer: string;
};

export type PiecesTranscript = {
  model: string;
  segments: StoredSegment[];
  words: StoredWord[];
  stats: { wordCount: number; segmentCount: number; droppedSegments: number };
  raw: { v: 1; promptVersion: string; pieces: Span[]; batches: PiecesBatchLog[] };
};

export async function transcribeInPieces(args: {
  file: string;
  durationMs: number;
  loudness: Loudness;
  language: Language;
  title: string;
  models: string[];
  batchMinutes: number;
  workDir: string;
  signal?: AbortSignal;
  log: Logger;
  beforeCall?: (target: LlmTarget) => Promise<void>;
  onProgress?: (fraction: number) => void;
}): Promise<PiecesTranscript> {
  const { log } = args;
  const chunks = chunkAudio(args.loudness, args.durationMs);
  const files = await cutPieces(args.file, chunks, args.workDir, args.signal);
  const control = await makeControlPiece(args.workDir, args.signal);

  // Consecutive pieces, ~batchMinutes of audio each.
  const batches: number[][] = [];
  let current: number[] = [];
  let currentMs = 0;
  for (const [i, c] of chunks.entries()) {
    current.push(i);
    currentMs += c.endMs - c.startMs;
    if (currentMs >= args.batchMinutes * 60_000) {
      batches.push(current);
      current = [];
      currentMs = 0;
    }
  }
  if (current.length) batches.push(current);

  // Each model once per round, two rounds: a busy model can take 1–2 min to say so, so it
  // isn't retried in place — the next model gets its turn first (2026-09-30: 10 min lost).
  let modelOrder = args.models;
  const texts: string[] = new Array<string>(chunks.length).fill("");
  const logs: PiecesBatchLog[] = new Array<PiecesBatchLog>(batches.length);

  // Smooth progress while batches are in flight (a batch takes ~30–90 s with no signal).
  let done = 0;
  const started = new Map<number, number>();
  const report = () => {
    let partial = 0;
    for (const t0 of started.values()) partial += 0.9 * (1 - Math.exp(-(Date.now() - t0) / EXPECTED_BATCH_MS));
    args.onProgress?.(Math.min((done + partial) / batches.length, 1));
  };
  const ticker = setInterval(report, 3_000);
  ticker.unref();
  // One batch failing for good stops the other lane too (the stage falls back to Whisper).
  const stop = new AbortController();
  const signal = args.signal ? AbortSignal.any([args.signal, stop.signal]) : stop.signal;

  const runBatch = async (b: number) => {
    const batch = batches[b]!;
    const slots = planSlots(batch);
    const request = buildPiecesPrompt({ language: args.language, title: args.title, count: slots.length });
    const audio = await Promise.all(
      slots.map(async (slot, k) => ({
        label: `Piece ${k + 1}:`,
        mimeType: "audio/ogg",
        base64: slot.kind === "control" ? control : (await readFile(files[slot.index]!)).toString("base64"),
      })),
    );
    const audioMs = batch.reduce((sum, i) => sum + chunks[i]!.endMs - chunks[i]!.startMs, 0);
    const round = modelOrder.map((model) => ({ provider: "gemini" as const, model }));
    started.set(b, Date.now());
    const out = await generateJson({
      targets: [...round, ...round],
      attemptsPerModel: 1,
      request: {
        ...request,
        audio,
        noThinking: true,
        schemaName: "pieces",
        schema: PIECES_SCHEMA,
        temperature: 0,
        // Real answers use ~400 tokens a minute; a model stuck repeating itself stops early.
        maxOutputTokens: Math.min(Math.max(Math.ceil(audioMs / 60_000) * 2_000, 4_096), 32_768),
        timeoutMs: 4 * 60_000,
      },
      parse: (t) => checkControls(slots, parsePieces(t, slots.length)),
      signal,
      log,
      beforeCall: args.beforeCall,
    });
    started.delete(b);
    done++;
    out.value.forEach((text, k) => (texts[batch[k]!] = text));
    // The model that worked goes first for the batches still to start.
    modelOrder = [out.target.model, ...args.models.filter((m) => m !== out.target.model)];
    logs[b] = {
      firstPiece: batch[0]!,
      count: batch.length,
      controls: slots.flatMap((slot, i) => (slot.kind === "control" ? [i + 1] : [])),
      target: out.target,
      attempts: out.attempts,
      latencyMs: out.result.latencyMs,
      usage: out.result.usage,
      answer: out.result.text,
    };
    log.info({ batch: b + 1, of: batches.length, pieces: batch.length, model: out.target.model, latencyMs: out.result.latencyMs }, "transcribed a batch of pieces");
    report();
  };

  try {
    // BATCH_CONCURRENCY batches at a time, in order.
    let next = 0;
    const lane = async () => {
      while (next < batches.length) await runBatch(next++);
    };
    await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, batches.length) }, lane));
  } catch (err) {
    stop.abort();
    throw err;
  } finally {
    clearInterval(ticker);
  }
  await rm(path.join(args.workDir, "pieces"), { recursive: true, force: true });

  const segments: StoredSegment[] = [];
  const words: StoredWord[] = [];
  for (const [i, chunk] of chunks.entries()) {
    const text = texts[i]!;
    if (!text) continue;
    segments.push({ startMs: chunk.startMs, endMs: chunk.endMs, text });
    words.push(...estimateWordTimes(text, chunk, args.loudness));
  }
  const models = [...new Set(logs.map((l) => l.target.model))];
  return {
    model: models.join("+"),
    segments,
    words,
    stats: { wordCount: words.length, segmentCount: segments.length, droppedSegments: 0 },
    raw: { v: 1, promptVersion: PIECES_PROMPT_VERSION, pieces: chunks, batches: logs },
  };
}

/** 1.5 s of silence in the same format as the pieces, base64. */
async function makeControlPiece(workDir: string, signal?: AbortSignal): Promise<string> {
  const file = path.join(workDir, "pieces", "control.ogg");
  await runTool(
    env.FFMPEG_PATH,
    ["-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", String(CONTROL_MS / 1000), "-c:a", "libopus", "-b:a", "24k", file],
    { timeoutMs: 30_000, signal, captureStdout: false },
  );
  return (await readFile(file)).toString("base64");
}

/** One ffmpeg pass: the audio → one small Opus file per piece, cut at the piece times. */
async function cutPieces(file: string, chunks: Span[], workDir: string, signal?: AbortSignal): Promise<string[]> {
  const dir = path.join(workDir, "pieces");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const times = chunks
    .slice(1)
    .map((c) => (c.startMs / 1000).toFixed(3))
    .join(",");
  await runTool(
    env.FFMPEG_PATH,
    [
      "-hide_banner",
      "-nostdin",
      "-y",
      "-loglevel",
      "error",
      "-i",
      file,
      "-map",
      "0:a:0",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "libopus",
      "-b:a",
      "24k",
      "-application",
      "voip",
      "-f",
      "segment",
      ...(times ? ["-segment_times", times] : []),
      "-reset_timestamps",
      "1",
      path.join(dir, "p%05d.ogg"),
    ],
    { timeoutMs: Math.max(2 * 60_000, (chunks.at(-1)?.endMs ?? 0) / 4), signal, captureStdout: false },
  );
  const files = (await readdir(dir)).filter((f) => /^p\d+\.ogg$/.test(f)).sort();
  if (files.length !== chunks.length) {
    throw new AppError("INTERNAL", { message: "Cutting the audio into pieces failed.", details: { expected: chunks.length, got: files.length } });
  }
  return files.map((f) => path.join(dir, f));
}
