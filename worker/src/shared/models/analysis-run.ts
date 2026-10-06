// GENERATED — do not edit. Source: shared/src/models/analysis-run.ts
// Edit the source, then run: node scripts/sync-shared.mjs

import { Schema, type InferSchemaType } from "mongoose";

import { msField, refField, registerModel, schemaVersionField, textField } from "../db/fields";
import { AI_PROVIDERS, ANALYSIS_KINDS, CLIP_INTENTS, RUN_STATUSES } from "../enums";

export const ANALYSIS_RUN_SCHEMA_VERSION = 1;

/**
 * One row per clip-selection run (first run, "give me more", or a natural-language search).
 * Records exactly which model and prompt produced which clips — the basis for measuring
 * and improving clip accuracy.
 */
const analysisRunSchema = new Schema(
  {
    schemaVersion: schemaVersionField(ANALYSIS_RUN_SCHEMA_VERSION),
    videoId: refField("Video", { required: true }),
    userId: refField("User", { required: true }),
    transcriptId: refField("Transcript", { required: true }),
    kind: { type: String, enum: ANALYSIS_KINDS, required: true },

    input: {
      intent: { type: String, enum: CLIP_INTENTS, required: true },
      query: textField({ maxlength: 500 }),
      targetClipCount: { type: Number, min: 1, max: 50, required: true },
      minClipMs: msField({ required: true }),
      maxClipMs: msField({ required: true }),
      excludeClipIds: { type: [{ type: Schema.Types.ObjectId, ref: "Clip" }], default: [] },
    },
    ai: {
      provider: { type: String, enum: AI_PROVIDERS, required: true },
      model: { type: String, required: true },
      promptVersion: { type: String, required: true },
      temperature: { type: Number, min: 0, max: 2 },
    },

    status: { type: String, enum: RUN_STATUSES, default: "running", required: true },
    usage: {
      inputTokens: { type: Number, min: 0 },
      outputTokens: { type: Number, min: 0 },
      latencyMs: msField(),
    },
    result: {
      /** How many moments the AI proposed vs how many survived snapping and dedup. */
      candidates: { type: Number, min: 0 },
      accepted: { type: Number, min: 0 },
    },
    rawResponse: {
      type: new Schema({ publicId: { type: String, required: true } }, { _id: false }),
    },
    error: {
      type: new Schema({ code: { type: String, required: true }, message: { type: String } }, { _id: false }),
    },
    finishedAt: { type: Date },
  },
  { timestamps: true },
);

analysisRunSchema.index({ videoId: 1, createdAt: -1 });
analysisRunSchema.index({ "ai.promptVersion": 1, "ai.model": 1, createdAt: -1 });

export type AnalysisRunDoc = InferSchemaType<typeof analysisRunSchema>;
export const AnalysisRun = registerModel("AnalysisRun", analysisRunSchema, "analysis_runs");
