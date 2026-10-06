import { Schema, type InferSchemaType } from "mongoose";

import { msField, refField, registerModel, schemaVersionField, textField } from "../db/fields";
import {
  AI_PROVIDERS,
  ASPECT_RATIOS,
  CLIP_INTENTS,
  CLIP_REQUEST_STATUSES,
  DEFAULT_CAPTION_STYLE_ID,
  LANGUAGES,
  SCRIPTS,
  SOURCE_TYPES,
  STAGE_NAMES,
  STAGE_STATUSES,
  ACTIVITY_KINDS,
  VIDEO_STATUSES,
} from "../enums";

export const VIDEO_SCHEMA_VERSION = 1;

const cloudinaryAssetSchema = new Schema(
  {
    publicId: { type: String, required: true },
    format: { type: String },
    bytes: { type: Number, min: 0 },
  },
  { _id: false },
);

const sourceSchema = new Schema(
  {
    type: { type: String, enum: SOURCE_TYPES, required: true },
    url: { type: String },
    externalId: { type: String },
    originalFilename: textField({ maxlength: 500 }),
    sizeBytes: { type: Number, min: 0 },
    cloudinary: { type: cloudinaryAssetSchema },
    oembed: {
      type: new Schema(
        {
          title: textField({ maxlength: 500 }),
          authorName: textField({ maxlength: 200 }),
          thumbnailUrl: { type: String },
        },
        { _id: false },
      ),
    },
  },
  { _id: false },
);

/** Legal record of the "I own this video or have permission" checkbox. */
const permissionSchema = new Schema(
  {
    confirmedAt: { type: Date, required: true },
    termsVersion: { type: String, required: true },
    ip: { type: String },
    userAgent: { type: String },
  },
  { _id: false },
);

const mediaSchema = new Schema(
  {
    durationMs: msField({ required: true }),
    width: { type: Number, min: 0 },
    height: { type: Number, min: 0 },
    fps: { type: Number, min: 0 },
    hasAudio: { type: Boolean, required: true },
    videoCodec: { type: String },
    audioCodec: { type: String },
  },
  { _id: false },
);

const audioSchema = new Schema(
  {
    publicId: { type: String, required: true },
    format: { type: String, required: true },
    bitrateKbps: { type: Number, min: 0 },
    bytes: { type: Number, min: 0 },
  },
  { _id: false },
);

const stageSchema = new Schema(
  {
    status: { type: String, enum: STAGE_STATUSES, default: "pending", required: true },
    progress: { type: Number, min: 0, max: 1, default: 0 },
    attempts: { type: Number, min: 0, default: 0 },
    startedAt: { type: Date },
    finishedAt: { type: Date },
  },
  { _id: false },
);

const stageField = () => ({ type: stageSchema, default: () => ({}) });

const errorSchema = new Schema(
  {
    code: { type: String, required: true },
    message: { type: String, required: true },
    stage: { type: String, enum: STAGE_NAMES },
    retryable: { type: Boolean, default: false },
    at: { type: Date, required: true },
  },
  { _id: false },
);

const videoSchema = new Schema(
  {
    schemaVersion: schemaVersionField(VIDEO_SCHEMA_VERSION),
    userId: refField("User", { required: true }),
    /** Client-generated id so a double-submitted form can't create two videos. */
    clientRequestId: { type: String },

    title: textField({ required: true, maxlength: 300 }),
    /** Spoken language: the user's choice, corrected by the transcribe step if clearly wrong. */
    language: { type: String, enum: LANGUAGES, required: true },
    /**
     * Result of checking the chosen language on audio samples before transcription
     * (worker: services/transcription/language.ts). `switched` = we used the other language.
     */
    languageCheck: {
      type: new Schema(
        {
          requested: { type: String, enum: LANGUAGES, required: true },
          detected: { type: [String], default: [] },
          switched: { type: Boolean, required: true },
          at: { type: Date, required: true },
        },
        { _id: false },
      ),
    },

    source: { type: sourceSchema, required: true },
    permission: { type: permissionSchema, required: true },
    media: { type: mediaSchema },
    audio: { type: audioSchema },

    options: {
      intent: { type: String, enum: CLIP_INTENTS, default: "best" },
      customQuery: textField({ maxlength: 500 }),
      targetClipCount: { type: Number, min: 1, max: 50, default: 10 },
      minClipMs: { ...msField(), default: 15_000 },
      maxClipMs: { ...msField(), default: 90_000 },
      aspectRatio: { type: String, enum: ASPECT_RATIOS, default: "9:16" },
      captionStyleId: { type: String, default: DEFAULT_CAPTION_STYLE_ID },
      /**
       * Letters for captions and post text of a Bangla video (Step 15): "Beng" = Bangla script,
       * "Latn" = Banglish. Unset = Bangla script. English videos are always "Latn".
       */
      captionScript: { type: String, enum: SCRIPTS },
    },

    status: { type: String, enum: VIDEO_STATUSES, default: "draft", required: true },
    pipeline: {
      /** New value on every (re)process; worker writes filter on it (zombie guard). */
      runId: { type: String },
      jobId: { type: String },
      stage: { type: String, enum: STAGE_NAMES },
      progress: { type: Number, min: 0, max: 1, default: 0 },
      heartbeatAt: { type: Date },
      /** Times a stuck run was restarted by the worker; reset when the user retries. */
      recoveries: { type: Number, min: 0, default: 0 },
      /**
       * Set while a `queued` video waits for the AI's daily quota to come back (Step 17): the
       * dispatcher skips it until then. `quotaWaits` counts the waits of this processing so a
       * video can't wait forever; both are reset when the user retries.
       */
      waitUntil: { type: Date },
      quotaWaits: { type: Number, min: 0, default: 0 },
      /**
       * What the current stage is doing right now, when that's worth telling the user
       * (a download: bytes, speed, time left). Cleared when the stage ends.
       */
      activity: {
        type: new Schema(
          {
            kind: { type: String, enum: ACTIVITY_KINDS, required: true },
            doneBytes: { type: Number, min: 0 },
            totalBytes: { type: Number, min: 0 },
            bytesPerSec: { type: Number, min: 0 },
            etaSec: { type: Number, min: 0 },
            at: { type: Date, required: true },
          },
          { _id: false },
        ),
      },
      /**
       * Admin asked to re-pick clips with this model/prompt (docs/ADMIN.md — Videos and jobs).
       * The analyze stage then makes a fresh "regenerate" run with exactly this model (no
       * fallback) instead of reusing the current one, and clears the field when it succeeds.
       */
      analyzeWith: {
        type: new Schema(
          {
            provider: { type: String, enum: AI_PROVIDERS, required: true },
            model: { type: String, required: true },
            promptVersion: { type: String, required: true },
            requestedBy: { type: String, required: true },
            at: { type: Date, required: true },
          },
          { _id: false },
        ),
      },
      stages: {
        ingest: stageField(),
        audio: stageField(),
        transcribe: stageField(),
        analyze: stageField(),
        copy: stageField(),
        render: stageField(),
      },
    },
    error: { type: errorSchema },

    currentTranscriptId: refField("Transcript"),
    currentAnalysisRunId: refField("AnalysisRun"),
    /**
     * The user's latest "Find new clips" request (Step 14, docs/SCHEMA.md §3.2). The video goes
     * back to the queue from "Finding moments"; the worker reads intent/query from `options`
     * (updated with the request) and records here how it ended. A failed or empty request
     * leaves the current clips as they were.
     */
    clipRequest: {
      type: new Schema(
        {
          status: { type: String, enum: CLIP_REQUEST_STATUSES, required: true },
          intent: { type: String, enum: CLIP_INTENTS, required: true },
          query: textField({ maxlength: 500 }),
          requestedAt: { type: Date, required: true },
          finishedAt: { type: Date },
          /** The new run, once it finished. */
          analysisRunId: refField("AnalysisRun"),
          errorCode: { type: String },
          /** Stage statuses before the request, restored when it fails (the old clips stay current). */
          previousStages: {
            analyze: { type: String, enum: STAGE_STATUSES },
            copy: { type: String, enum: STAGE_STATUSES },
            render: { type: String, enum: STAGE_STATUSES },
          },
        },
        { _id: false },
      ),
    },
    counts: {
      clips: { type: Number, min: 0, default: 0 },
      renders: { type: Number, min: 0, default: 0 },
      /** "Find new clips" requests made (checked against the plan's clipRequestsPerVideo). */
      clipRequests: { type: Number, min: 0, default: 0 },
      /** "Write again" / Banglish switches made (plan limit copyRequestsPerVideo). */
      copyRequests: { type: Number, min: 0, default: 0 },
    },
    thumbnailUrl: { type: String },

    /**
     * Expiry is computed, never stored (docs/SCHEMA.md §8) — see retention.ts.
     * finishedAt starts the clock; expireOverrideAt is an admin's per-video choice.
     */
    retention: {
      finishedAt: { type: Date },
      expireOverrideAt: { type: Date },
      assetsDeletedAt: { type: Date },
    },

    deletedAt: { type: Date },
  },
  { timestamps: true },
);

videoSchema.index({ userId: 1, createdAt: -1 });
videoSchema.index({ status: 1, "pipeline.heartbeatAt": 1 });
videoSchema.index({ status: 1, updatedAt: -1 });
// Both halves of the cleanup job's $or (see retention.ts → expiryCandidatesFilter).
videoSchema.index({ "retention.finishedAt": 1 });
videoSchema.index({ "retention.expireOverrideAt": 1 }, { sparse: true });
videoSchema.index(
  { userId: 1, clientRequestId: 1 },
  { unique: true, partialFilterExpression: { clientRequestId: { $type: "string" } } },
);

export type VideoDoc = InferSchemaType<typeof videoSchema>;
export const Video = registerModel("Video", videoSchema, "videos");
