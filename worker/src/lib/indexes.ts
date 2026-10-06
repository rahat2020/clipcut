import mongoose from "mongoose";

import { ALL_MODELS } from "../shared";

/**
 * Every UNIQUE index our schemas declare must exist in the database, or the rules they enforce
 * silently stop working — most importantly `usage_events.idempotencyKey`, which is what stops a
 * retried video from being charged its minutes twice (D33). In production Mongoose never builds
 * indexes on its own (`npm run db:indexes` does), so a forgotten step would go unnoticed.
 * The worker calls this at boot and refuses to start when one is missing.
 *
 * Returns the missing ones as "<collection>: <fields>" (empty = all there).
 */
export async function missingUniqueIndexes(): Promise<string[]> {
  const missing: string[] = [];
  for (const Model of ALL_MODELS as readonly mongoose.Model<unknown>[]) {
    const wanted = Model.schema.indexes().filter(([, options]) => options?.unique);
    if (wanted.length === 0) continue;
    let existing: { key: Record<string, unknown> }[] = [];
    try {
      existing = await Model.collection.indexes();
    } catch {
      // the collection doesn't exist yet: everything is missing
    }
    for (const [fields] of wanted) {
      if (!existing.some((e) => JSON.stringify(e.key) === JSON.stringify(fields))) {
        missing.push(`${Model.collection.collectionName}: ${JSON.stringify(fields)}`);
      }
    }
  }
  return missing;
}

/** Throws (so the worker doesn't start) when a unique index is missing. */
export async function assertUniqueIndexes(): Promise<void> {
  const missing = await missingUniqueIndexes();
  if (missing.length > 0) {
    throw new Error(`These unique indexes are missing: ${missing.join("; ")}. Run \`npm run db:indexes\` against this database, then start the worker again.`);
  }
}
