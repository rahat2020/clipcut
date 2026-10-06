import { Schema, type InferSchemaType } from "mongoose";

import { msField, refField, registerModel, schemaVersionField, textField } from "../db/fields";
import { LANGUAGES, SCRIPTS, TRANSCRIPT_KINDS } from "../enums";

export const TRANSCRIPT_SCHEMA_VERSION = 1;

const segmentSchema = new Schema(
  {
    startMs: msField({ required: true }),
    endMs: msField({ required: true }),
    text: textField({ required: true }),
    /** Whisper's confidence — helps boundary snapping tell speech from noise. */
    avgLogprob: { type: Number },
    noSpeechProb: { type: Number, min: 0, max: 1 },
  },
  { _id: false },
);

const assetPointerSchema = new Schema(
  {
    publicId: { type: String, required: true },
    url: { type: String },
    count: { type: Number, min: 0 },
  },
  { _id: false },
);

/**
 * Versioned: version 1 comes from Whisper; later versions from user edits or Banglish
 * transliteration. Versions are never mutated, so a clip always knows its exact text.
 */
const transcriptSchema = new Schema(
  {
    schemaVersion: schemaVersionField(TRANSCRIPT_SCHEMA_VERSION),
    videoId: refField("Video", { required: true }),
    userId: refField("User", { required: true }),
    version: { type: Number, required: true, min: 1 },
    kind: { type: String, enum: TRANSCRIPT_KINDS, required: true },
    basedOnVersion: { type: Number, min: 1 },

    language: { type: String, enum: LANGUAGES, required: true },
    script: { type: String, enum: SCRIPTS, required: true },
    provider: { type: String },
    model: { type: String },
    /**
     * Where word times come from: "asr" = the speech model (Whisper); "estimated" = spread
     * over each piece's speech by length (Gemini gives text per piece, D42).
     */
    wordTiming: { type: String, enum: ["asr", "estimated"] },
    durationMs: msField(),

    segments: { type: [segmentSchema], default: [] },
    /** Word-level timestamps live in Cloudinary (raw JSON) — too big for Mongo's 0.5 GB. */
    words: { type: assetPointerSchema },
    /** Untouched provider response, for reprocessing. */
    raw: { type: assetPointerSchema },
    /**
     * Banglish (Latin letters) for Bangla captions, Step 15: "<startMs>_<endMs>" of a caption
     * word → its Banglish spelling. Filled only for words inside clips, as they're needed, so it
     * stays small.
     */
    latnWords: { type: Schema.Types.Mixed }, // Record<string, string>, written key by key ($set "latnWords.<key>")

    stats: {
      wordCount: { type: Number, min: 0, default: 0 },
      segmentCount: { type: Number, min: 0, default: 0 },
      avgLogprob: { type: Number },
      /** Segments removed as silence/noise or repeated-phrase loops (Whisper hallucinations). */
      droppedSegments: { type: Number, min: 0, default: 0 },
    },
  },
  { timestamps: true },
);

transcriptSchema.index({ videoId: 1, version: -1 }, { unique: true });

export type TranscriptDoc = InferSchemaType<typeof transcriptSchema>;
export const Transcript = registerModel("Transcript", transcriptSchema, "transcripts");
