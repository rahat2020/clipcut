// GENERATED — do not edit. Source: shared/src/models/usage-event.ts
// Edit the source, then run: node scripts/sync-shared.mjs

import { Schema, type InferSchemaType } from "mongoose";

import { refField, registerModel, schemaVersionField } from "../db/fields";
import { USAGE_TYPES, USAGE_UNITS } from "../enums";

export const USAGE_EVENT_SCHEMA_VERSION = 1;

/**
 * Append-only ledger of everything billable or rate-limited. Never updated or deleted.
 * `users.quota` is a fast counter; if the two ever disagree, this ledger wins.
 */
const usageEventSchema = new Schema(
  {
    schemaVersion: schemaVersionField(USAGE_EVENT_SCHEMA_VERSION),
    userId: refField("User", { required: true }),
    videoId: refField("Video"),
    type: { type: String, enum: USAGE_TYPES, required: true },
    quantity: { type: Number, required: true, min: 0 },
    unit: { type: String, enum: USAGE_UNITS, required: true },
    provider: { type: String },
    model: { type: String },
    /** e.g. "video:<id>:run:<runId>:transcribe" — a retried job can't charge twice. */
    idempotencyKey: { type: String, required: true },
    at: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: false },
);

usageEventSchema.index({ idempotencyKey: 1 }, { unique: true });
usageEventSchema.index({ userId: 1, at: -1 });
usageEventSchema.index({ provider: 1, at: -1 });

export type UsageEventDoc = InferSchemaType<typeof usageEventSchema>;
export const UsageEvent = registerModel("UsageEvent", usageEventSchema, "usage_events");
