// GENERATED — do not edit. Source: shared/src/db/configure.ts
// Edit the source, then run: node scripts/sync-shared.mjs

import mongoose from "mongoose";

let configured = false;

/**
 * Global Mongoose behaviour shared by web and worker. Call once before connecting.
 *
 * - strictQuery "throw": a filter on a field that isn't in the schema throws instead of
 *   being silently dropped. With `true`, `deleteMany({ typoField: x })` becomes
 *   `deleteMany({})` and wipes the collection; with `false` it silently matches nothing.
 * - runValidators: schema validators (integer ms, enums, min/max) also run on
 *   updateOne/findOneAndUpdate, not only on create/save. We only use targeted updates,
 *   so without this most writes would skip validation.
 */
export function configureMongoose(): void {
  if (configured) return;
  mongoose.set("strictQuery", "throw");
  mongoose.set("runValidators", true);
  configured = true;
}
