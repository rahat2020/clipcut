// GENERATED — do not edit. Source: shared/src/migrations/types.ts
// Edit the source, then run: node scripts/sync-shared.mjs

import type mongoose from "mongoose";

export type MigrationContext = {
  /** Raw driver database — migrations use it directly so they keep working after models change. */
  db: mongoose.mongo.Db;
  log: (message: string) => void;
};

/**
 * One schema change. Rules (docs/SCHEMA.md §6):
 * - `id` is "NNNN-kebab-description" and never changes once applied anywhere.
 * - `up` must be idempotent: running it twice leaves the same result.
 * - Work in batches and filter on `schemaVersion` so a half-finished run can resume.
 * - Never import models here; describe the data as it was when the migration was written.
 */
export type Migration = {
  id: string;
  description: string;
  up: (ctx: MigrationContext) => Promise<void>;
};
