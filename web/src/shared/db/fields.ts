// GENERATED — do not edit. Source: shared/src/db/fields.ts
// Edit the source, then run: node scripts/sync-shared.mjs

import mongoose, { Schema } from "mongoose";

import { normalizeText } from "../text";

/**
 * Registers a model once. Next.js hot reload re-evaluates modules, and registering the
 * same name twice throws OverwriteModelError, so reuse the existing model if present.
 * The cast keeps the precise type Mongoose infers from the schema.
 */
export function registerModel<TSchema extends Schema>(name: string, schema: TSchema, collection: string) {
  const create = () => mongoose.model(name, schema, collection);
  const existing = mongoose.models[name] as ReturnType<typeof create> | undefined;
  if (!existing || existing.schema === schema) return existing ?? create();
  // Same name, different schema object = this file was re-run by hot reload (next dev) after a
  // schema change. Keeping the old model would reject the new fields (strictQuery "throw":
  // "counts.copyRequests is not in schema", 2026-10-02), so compile the new one. Production
  // runs each file once, so this never happens there.
  if (process.env.NODE_ENV === "production") return existing;
  mongoose.deleteModel(name);
  return create();
}

/** Media position or duration in integer milliseconds. Floats are rejected. */
export function msField(options: { required?: boolean } = {}) {
  return {
    type: Number,
    required: options.required ?? false,
    min: 0,
    validate: { validator: (v: number | null | undefined) => v == null || Number.isInteger(v), message: "{PATH} must be an integer number of milliseconds" },
  } as const;
}

/** Text that is NFC-normalised on every write (see text.ts). */
export function textField(options: { required?: boolean; maxlength?: number; default?: string } = {}) {
  return {
    type: String,
    required: options.required ?? false,
    maxlength: options.maxlength,
    default: options.default,
    set: (v: string | null | undefined) => normalizeText(v),
  } as const;
}

/** A reference to another document. */
export function refField(model: string, options: { required?: boolean; index?: boolean } = {}) {
  return {
    type: Schema.Types.ObjectId,
    ref: model,
    required: options.required ?? false,
    index: options.index ?? false,
  } as const;
}

/** Every document records which shape it was written in (docs/SCHEMA.md §6.3). */
export function schemaVersionField(current: number) {
  return { type: Number, required: true, default: current } as const;
}
