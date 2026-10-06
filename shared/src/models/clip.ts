import { Schema, type InferSchemaType } from "mongoose";

import { msField, refField, registerModel, schemaVersionField, textField } from "../db/fields";
import { CLIP_ORIGINS, CLIP_STATUSES, DEFAULT_CAPTION_STYLE_ID, LANGUAGES, MOMENT_TYPES, SCRIPTS } from "../enums";

export const CLIP_SCHEMA_VERSION = 1;

/** What the AI proposed, before our code snapped the boundaries. Kept for evaluation. */
const aiProposalSchema = new Schema(
  {
    rawStartMs: msField({ required: true }),
    rawEndMs: msField({ required: true }),
    score: { type: Number, min: 0, max: 1 },
    momentType: { type: String, enum: MOMENT_TYPES, default: "other" },
    reason: textField({ maxlength: 1000 }),
  },
  { _id: false },
);

/** One cover idea (copy@3+): the words, and the word(s) shown in the second colour. */
const coverOptionSchema = new Schema(
  {
    text: textField({ maxlength: 80 }),
    /** Copied from `text`; "" = no second colour. */
    highlight: textField({ maxlength: 80 }),
  },
  { _id: false },
);

const copySchema = new Schema(
  {
    title: textField({ maxlength: 200 }),
    description: textField({ maxlength: 2000 }),
    /** Always AI-written — the UI labels it so it isn't mistaken for the speaker's words. */
    hook: textField({ maxlength: 300 }),
    hashtags: { type: [String], default: [] },
    /** 2–5 punchy words for the cover image (copy@2+, Step 15.5). */
    coverText: textField({ maxlength: 80 }),
    /** Up to 3 cover ideas, the first = `coverText` (copy@3+, Step 15.6). */
    coverOptions: { type: [coverOptionSchema], default: undefined },
    language: { type: String, enum: LANGUAGES },
    script: { type: String, enum: SCRIPTS },
    model: { type: String },
    promptVersion: { type: String },
    writtenAt: { type: Date },
    /** The user changed the text by hand. */
    editedAt: { type: Date },
  },
  { _id: false },
);

const clipSchema = new Schema(
  {
    schemaVersion: schemaVersionField(CLIP_SCHEMA_VERSION),
    videoId: refField("Video", { required: true }),
    userId: refField("User", { required: true }),
    /** Null for clips the user made by hand. */
    analysisRunId: refField("AnalysisRun"),
    origin: { type: String, enum: CLIP_ORIGINS, required: true },
    rank: { type: Number, min: 1 },

    /** Final boundaries, after snapping. */
    startMs: msField({ required: true }),
    endMs: msField({ required: true }),
    durationMs: msField({ required: true }),

    ai: { type: aiProposalSchema },
    /** How the boundaries were cut (docs/SCHEMA.md §3.5). */
    snap: {
      /** "snap@1" (Step 10), or "lines" = whole-line times only. */
      version: { type: String },
      /** What the cut used: "words+audio" · "words" · "segments+audio" · "segments" · "lines". */
      basis: { type: String },
      startRule: { type: String },
      endRule: { type: String },
    },
    transcriptText: textField(),
    /** Post text: title, hook, description, hashtags (Step 15, the "copy" stage). */
    copy: { type: copySchema },
    /** The user asked for new post text ("Write again"); the copy stage clears it. */
    copyRedoAt: { type: Date },
    /** The user asked for new cover words only ("Suggest words"); the copy stage clears it. */
    coverRedoAt: { type: Date },

    edit: {
      /** Horizontal crop position for 9:16: -1 = far left, 0 = center, 1 = far right. */
      cropOffsetX: { type: Number, min: -1, max: 1, default: 0 },
      captionStyleId: { type: String, default: DEFAULT_CAPTION_STYLE_ID },
      captionScript: { type: String, enum: SCRIPTS, default: "Beng" },
      /**
       * The cut before the user first trimmed it (after snapping), for "Reset" and as an
       * accuracy signal (how far users move the AI's edges). Unset = never trimmed.
       */
      aiStartMs: msField(),
      aiEndMs: msField(),
    },

    status: { type: String, enum: CLIP_STATUSES, default: "suggested", required: true },
    /** Why the user rejected it — a direct accuracy signal. */
    feedback: {
      type: new Schema({ reason: textField({ maxlength: 500 }), at: { type: Date, required: true } }, { _id: false }),
    },
    /** Implicit "this clip was good" signals. */
    signals: {
      rendered: { type: Boolean, default: false },
      downloaded: { type: Boolean, default: false },
    },
    latestRenderId: refField("Render"),
    /**
     * Set when a new set of clips replaced this clip's run while the user had it approved
     * (Step 14): it stays on the video page next to the new set. Cleared when a later set
     * arrives and it's no longer approved. See clip-sets.ts.
     */
    keptAt: { type: Date },
    deletedAt: { type: Date },
  },
  { timestamps: true },
);

clipSchema.index({ videoId: 1, status: 1, rank: 1 });
clipSchema.index({ analysisRunId: 1 });

export type ClipDoc = InferSchemaType<typeof clipSchema>;
export const Clip = registerModel("Clip", clipSchema, "clips");
