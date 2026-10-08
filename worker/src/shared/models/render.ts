// GENERATED — do not edit. Source: shared/src/models/render.ts
// Edit the source, then run: node scripts/sync-shared.mjs

import { Schema, type InferSchemaType } from "mongoose";

import { msField, refField, registerModel, schemaVersionField } from "../db/fields";
import { ASPECT_RATIOS, RENDER_STATUSES, SCRIPTS } from "../enums";

export const RENDER_SCHEMA_VERSION = 1;

/** Everything that affects the output pixels. Its hash makes identical requests reuse one render. */
const renderSpecSchema = new Schema(
  {
    startMs: msField({ required: true }),
    endMs: msField({ required: true }),
    aspectRatio: { type: String, enum: ASPECT_RATIOS, required: true },
    width: { type: Number, min: 1, required: true },
    height: { type: Number, min: 1, required: true },
    cropOffsetX: { type: Number, min: -1, max: 1, default: 0 },
    captionStyleId: { type: String, required: true },
    captionScript: { type: String, enum: SCRIPTS, required: true },
    burnCaptions: { type: Boolean, default: true },
    transcriptVersion: { type: Number, min: 1 },
    /** Caption words in the second colour (render@3). Missing on older renders = none. */
    emphasis: { type: [String], default: undefined },
    /** Auto zoom (render@3). Missing on older renders = off. */
    autoZoom: { type: Boolean },
  },
  { _id: false },
);

/** One encoded MP4. Expires together with its video (docs/SCHEMA.md §8). */
const renderSchema = new Schema(
  {
    schemaVersion: schemaVersionField(RENDER_SCHEMA_VERSION),
    clipId: refField("Clip", { required: true }),
    videoId: refField("Video", { required: true }),
    userId: refField("User", { required: true }),

    spec: { type: renderSpecSchema, required: true },
    specHash: { type: String, required: true },

    status: { type: String, enum: RENDER_STATUSES, default: "queued", required: true },
    progress: { type: Number, min: 0, max: 1, default: 0 },
    attempts: { type: Number, min: 0, default: 0 },
    output: {
      type: new Schema(
        {
          publicId: { type: String, required: true },
          secureUrl: { type: String, required: true },
          bytes: { type: Number, min: 0 },
          durationMs: msField(),
        },
        { _id: false },
      ),
    },
    timings: {
      queuedAt: { type: Date, default: () => new Date() },
      startedAt: { type: Date },
      /** Touched while rendering; a silent one is restarted (RENDER_TIMING). */
      heartbeatAt: { type: Date },
      finishedAt: { type: Date },
      encodeMs: msField(),
    },
    /**
     * Clean 9:16 frames of the clip (no captions) for the cover editor (Step 15.5), private
     * JPEGs next to the MP4. Empty for renders made before covers existed.
     */
    coverFrames: { type: [String], default: [] },
    /** Set by the cleanup job once the MP4 is removed from Cloudinary. */
    assetDeletedAt: { type: Date },
    error: {
      type: new Schema(
        {
          code: { type: String, required: true },
          message: { type: String },
          /** Technical tail (e.g. yt-dlp stderr) for debugging — never shown to users. */
          detail: { type: String, maxlength: 1000 },
        },
        { _id: false },
      ),
    },
  },
  { timestamps: true },
);

renderSchema.index({ clipId: 1, specHash: 1 }, { unique: true });
renderSchema.index({ videoId: 1 });
/** The render queue's dispatcher and stuck sweep. */
renderSchema.index({ status: 1, "timings.queuedAt": 1 });

export type RenderDoc = InferSchemaType<typeof renderSchema>;
export const Render = registerModel("Render", renderSchema, "renders");
