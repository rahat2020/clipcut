import { z } from "zod";

import { AppError, cleanCoverHighlight, normalizeHashtags, oneLineText, POST_COPY, type Language, type Script } from "../../shared";
import type { JsonSchema } from "../ai/llm";

/**
 * Post text prompts ("copy", Step 15), by version — `settings.ai.copyWriting.promptVersion`
 * picks one and every clip records which wrote its text. Never edit a released version's
 * wording: add a new one.
 *
 * One request writes the text for every clip of a video: the free tier counts requests,
 * not clips (gemini-2.5-flash: 20 a day).
 */

export type CopyClipInput = {
  /** 1-based, how the answer refers to the clip. */
  n: number;
  /** What is said in the clip. */
  text: string;
  momentType: string;
  /** Why the clip was picked (clip selection's reason). */
  reason: string;
  durationMs: number;
};

export type CopyInput = { title: string; language: Language; script: Script; clips: readonly CopyClipInput[] };

export type CopyPrompt = { system: string; prompt: string; schema: JsonSchema };

/** Said text sent per clip — a 3-minute clip is ~2,500 characters of Bangla. */
const MAX_TEXT_CHARS = 2_500;

// ── copy@1 ───────────────────────────────────────────────────

const SYSTEM_V1 = `You write the post text for short vertical video clips (YouTube Shorts, Facebook Reels, TikTok) for creators in Bangladesh. For each clip you get what is said in it and why it was picked. You write a title, a hook, a short description and hashtags.

Everything must be true to what is said in the clip: never invent facts, names, numbers or results, and never promise something the clip doesn't show. Specific beats generic — "Fahan's first goal for Bangladesh" is better than "Amazing football moment".

The text comes from automatic speech recognition and may contain misheard words; read for meaning.`;

const SCRIPT_RULES_V1: Record<"bn-Beng" | "bn-Latn" | "en", string> = {
  "bn-Beng":
    "Write in natural, everyday Bangla in Bengali script, the way Bangladeshi creators write their posts. Names and well-known English terms may stay in English letters inside hashtags.",
  "bn-Latn":
    'Write in Banglish: Bangla written in English letters the way people in Bangladesh type on Facebook and YouTube (for example "ki hoyeche", "khela shesh", "amra jitbo"). This is NOT an English translation — the words are Bangla. Hashtags in English letters.',
  en: "Write in natural, conversational English.",
};

/**
 * copy@1 exactly as released; copy@2 (Step 15.5) adds one line asking for the cover text;
 * copy@3 (Step 15.6) asks instead for three cover ideas, each with its key word.
 */
type CoverAsk = "none" | "text" | "options";

const COVER_LINES: Record<CoverAsk, string> = {
  none: "",
  text: "- cover_text: 2 to 5 punchy words for big letters on the clip's cover image, in the same language and letters — the name, the moment or the surprise (\"ফাহানের প্রথম গোল!\"). No hashtags, no emoji.\n",
  options:
    "- cover_options: 3 different ideas for the big words on the clip's cover image, each 2 to 5 punchy words in the same language and letters: the name with the moment (\"ফাহানের প্রথম গোল!\"), the feeling or the surprise, a short question. Never a full sentence, never the title again. For each idea give text and highlight: the ONE most important word of that text, copied exactly, which is shown in a second colour. No hashtags, no emoji.\n",
};

const buildV1 = (input: CopyInput) => build(input, "none");
const buildV2 = (input: CopyInput) => build(input, "text");
const buildV3 = (input: CopyInput) => build(input, "options");

function build(input: CopyInput, cover: CoverAsk): CopyPrompt {
  const key = input.language === "en" ? "en" : input.script === "Latn" ? "bn-Latn" : "bn-Beng";
  const clips = input.clips
    .map(
      (c) =>
        `Clip ${c.n} (${c.momentType}, ${Math.round(c.durationMs / 1000)} s)\nWhy it was picked: ${oneLine(c.reason, 400)}\nSaid: «${oneLine(c.text, MAX_TEXT_CHARS)}»`,
    )
    .join("\n\n");

  const prompt = `Video title: «${oneLine(input.title, 300)}»

Language: ${SCRIPT_RULES_V1[key]}

For EVERY clip below write:
- title: at most 70 characters (about 8 words). What the viewer gets from this clip. No ALL CAPS, no hashtags, at most one emoji.
- hook: one short sentence, at most 100 characters, for the first line of the post — a question, a striking line from the clip, or its surprise — so people stop scrolling.
- description: one or two sentences, at most 250 characters, saying what happens in the clip.
- hashtags: 3 to 6 tags specific to this clip (topic, people, team, place), at most one broad tag. No spaces inside a tag.
${COVER_LINES[cover]}Each clip's text must stand on its own; don't repeat the same title for two clips.

${clips}`;
  return { system: SYSTEM_V1, prompt, schema: cover === "options" ? COPY_SCHEMA_V3 : cover === "text" ? COPY_SCHEMA_V2 : COPY_SCHEMA };
}

const PROMPTS: Record<string, (input: CopyInput) => CopyPrompt> = { "copy@1": buildV1, "copy@2": buildV2, "copy@3": buildV3 };
export const LATEST_COPY_PROMPT = "copy@3";

export function buildCopyPrompt(version: string, input: CopyInput): { version: string; prompt: CopyPrompt } {
  const known = PROMPTS[version] ? version : LATEST_COPY_PROMPT;
  return { version: known, prompt: PROMPTS[known]!(input) };
}

// ── answer ───────────────────────────────────────────────────

export const COPY_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    clips: {
      type: "array",
      items: {
        type: "object",
        properties: {
          clip: { type: "integer" },
          title: { type: "string" },
          hook: { type: "string" },
          description: { type: "string" },
          hashtags: { type: "array", items: { type: "string" } },
        },
        required: ["clip", "title", "hook", "description", "hashtags"],
        additionalProperties: false,
      },
    },
  },
  required: ["clips"],
  additionalProperties: false,
};

/** copy@2: the same plus `cover_text`. */
export const COPY_SCHEMA_V2: JsonSchema = {
  type: "object",
  properties: {
    clips: {
      type: "array",
      items: {
        type: "object",
        properties: {
          clip: { type: "integer" },
          title: { type: "string" },
          hook: { type: "string" },
          description: { type: "string" },
          hashtags: { type: "array", items: { type: "string" } },
          cover_text: { type: "string" },
        },
        required: ["clip", "title", "hook", "description", "hashtags", "cover_text"],
        additionalProperties: false,
      },
    },
  },
  required: ["clips"],
  additionalProperties: false,
};

/** copy@3: `cover_options` (three ideas with their key word) instead of `cover_text`. */
export const COPY_SCHEMA_V3: JsonSchema = {
  type: "object",
  properties: {
    clips: {
      type: "array",
      items: {
        type: "object",
        properties: {
          clip: { type: "integer" },
          title: { type: "string" },
          hook: { type: "string" },
          description: { type: "string" },
          hashtags: { type: "array", items: { type: "string" } },
          cover_options: {
            type: "array",
            items: {
              type: "object",
              properties: { text: { type: "string" }, highlight: { type: "string" } },
              required: ["text", "highlight"],
              additionalProperties: false,
            },
          },
        },
        required: ["clip", "title", "hook", "description", "hashtags", "cover_options"],
        additionalProperties: false,
      },
    },
  },
  required: ["clips"],
  additionalProperties: false,
};

const coverOptionSchema = z.object({ text: z.string(), highlight: z.string().catch("") });

const itemSchema = z.object({
  clip: z.number().int(),
  title: z.string(),
  hook: z.string().catch(""),
  description: z.string().catch(""),
  hashtags: z.array(z.string()).catch([]),
  cover_text: z.string().catch(""),
  cover_options: z.array(z.unknown()).catch([]),
});

export type CoverOption = { text: string; highlight: string };
export type PostCopy = { title: string; hook: string; description: string; hashtags: string[]; coverText: string; coverOptions: CoverOption[] };

/** Cleaned cover ideas: one line within the limit, no repeats, a highlight that is really in the text. */
function cleanCoverOptions(raw: readonly unknown[]): CoverOption[] {
  const out: CoverOption[] = [];
  for (const item of raw) {
    const p = coverOptionSchema.safeParse(item);
    if (!p.success) continue;
    const text = oneLineText(p.data.text.replace(/#/g, ""), POST_COPY.coverTextMaxChars);
    if (!text || out.some((o) => o.text === text)) continue;
    out.push({ text, highlight: cleanCoverHighlight(text, p.data.highlight) });
    if (out.length >= POST_COPY.maxCoverOptions) break;
  }
  return out;
}

/**
 * The model's JSON → cleaned text per clip number. Unreadable JSON fails the answer (retried);
 * a clip that's missing or has no title is simply left out (the user can ask again).
 */
export function parseCopy(text: string): Map<number, PostCopy> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    throw new AppError("AI_OUTPUT_INVALID", { cause, details: { reason: "not JSON", start: text.slice(0, 120) } });
  }
  const list = (json as { clips?: unknown } | null)?.clips;
  if (!Array.isArray(list)) throw new AppError("AI_OUTPUT_INVALID", { details: { reason: "no clips array" } });
  const out = new Map<number, PostCopy>();
  for (const item of list) {
    const p = itemSchema.safeParse(item);
    if (!p.success) continue;
    const title = oneLineText(p.data.title, POST_COPY.titleMaxChars);
    if (!title || out.has(p.data.clip)) continue;
    const coverOptions = cleanCoverOptions(p.data.cover_options);
    out.set(p.data.clip, {
      title,
      hook: oneLineText(p.data.hook, POST_COPY.hookMaxChars),
      description: oneLineText(p.data.description, POST_COPY.descriptionMaxChars),
      hashtags: normalizeHashtags(p.data.hashtags),
      coverText: oneLineText(p.data.cover_text, POST_COPY.coverTextMaxChars) || (coverOptions[0]?.text ?? ""),
      coverOptions,
    });
  }
  return out;
}

/** User text (titles, speech) inside our « » quotes: one line, no « » of its own. */
function oneLine(text: string, max: number): string {
  return text.replace(/[«»]/g, '"').replace(/\s+/g, " ").trim().slice(0, max);
}
