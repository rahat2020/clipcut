// GENERATED — do not edit. Source: shared/src/models/user.ts
// Edit the source, then run: node scripts/sync-shared.mjs

import { Schema, type InferSchemaType } from "mongoose";

import { refField, registerModel, schemaVersionField, textField } from "../db/fields";
import { DEFAULT_PLAN, LANGUAGES, USER_ROLES, USER_STATUSES } from "../enums";

export const USER_SCHEMA_VERSION = 1;

/** Per-user exceptions to plan limits, set from the admin panel. Unset = use the plan's value. */
const limitsOverrideSchema = new Schema(
  {
    monthlyMinutes: { type: Number, min: 0 },
    maxFileMB: { type: Number, min: 1, max: 100 },
    maxDurationMin: { type: Number, min: 1 },
    concurrentJobs: { type: Number, min: 1 },
    maxClipsPerVideo: { type: Number, min: 1 },
    clipRequestsPerVideo: { type: Number, min: 0 },
    copyRequestsPerVideo: { type: Number, min: 0 },
    allowYoutube: { type: Boolean },
  },
  { _id: false },
);

const suspensionSchema = new Schema(
  {
    reason: textField({ required: true, maxlength: 500 }),
    at: { type: Date, required: true },
    byUserId: refField("User"),
  },
  { _id: false },
);

const userSchema = new Schema(
  {
    schemaVersion: schemaVersionField(USER_SCHEMA_VERSION),
    clerkId: { type: String, required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    name: textField({ maxlength: 200 }),
    imageUrl: { type: String },

    uiLocale: { type: String, enum: LANGUAGES, default: "bn" },
    defaultVideoLanguage: { type: String, enum: LANGUAGES, default: "bn" },

    role: { type: String, enum: USER_ROLES, default: "user", required: true },
    status: { type: String, enum: USER_STATUSES, default: "active", required: true },
    suspension: { type: suspensionSchema },

    plan: { type: String, default: DEFAULT_PLAN, required: true },
    limitsOverride: { type: limitsOverrideSchema },
    quota: {
      periodStart: { type: Date, default: () => new Date() },
      minutesUsed: { type: Number, default: 0, min: 0 },
    },
    flags: {
      betaTester: { type: Boolean, default: false },
    },

    lastSeenAt: { type: Date },
    deletedAt: { type: Date },
  },
  { timestamps: true },
);

userSchema.index({ clerkId: 1 }, { unique: true });
userSchema.index({ email: 1 });
userSchema.index({ role: 1 });
userSchema.index({ createdAt: -1 });

export type UserDoc = InferSchemaType<typeof userSchema>;
export const User = registerModel("User", userSchema, "users");
