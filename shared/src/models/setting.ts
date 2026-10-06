import { Schema, type InferSchemaType } from "mongoose";

import { refField, registerModel } from "../db/fields";
import { SETTINGS_GROUPS } from "../enums";

/**
 * One document per settings group (`_id` = "ai" | "limits" | "retention" | "system").
 * `data` is validated by the zod schemas in settings/schemas.ts, not by Mongoose, so the
 * shape is defined in exactly one place. Read and write only through settings/service.ts.
 */
const settingSchema = new Schema(
  {
    _id: { type: String, enum: SETTINGS_GROUPS, required: true },
    /** Version of the zod schema `data` was written with. */
    schemaVersion: { type: Number, required: true, default: 1 },
    data: { type: Schema.Types.Mixed, required: true, default: () => ({}) },
    /** Incremented on every save; a save based on a stale copy is rejected. */
    version: { type: Number, required: true, default: 0, min: 0 },
    updatedBy: refField("User"),
    updatedByEmail: { type: String },
  },
  { timestamps: true, minimize: false },
);

export type SettingDoc = InferSchemaType<typeof settingSchema>;
export const Setting = registerModel("Setting", settingSchema, "settings");
