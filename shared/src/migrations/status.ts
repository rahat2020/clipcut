import type mongoose from "mongoose";

import { MIGRATIONS } from "./index";

/**
 * Which migrations ran (docs/SCHEMA.md §6.4). Read by the worker's `npm run migrate -- --status`
 * and by the admin System page (read-only — migrations never run from the browser).
 */

export const MIGRATIONS_COLLECTION = "_migrations";
export const MIGRATIONS_LOCK_ID = "__lock";

export type MigrationRecord = { _id: string; description?: string; appliedAt?: Date; durationMs?: number; at?: Date; by?: string };

export type MigrationStatus = {
  applied: { id: string; appliedAt: Date }[];
  pending: { id: string; description: string }[];
  /** In the database but not in code — someone deleted or renamed a migration. */
  unknown: string[];
};

export async function migrationStatus(db: mongoose.mongo.Db): Promise<MigrationStatus> {
  const records = await db
    .collection<MigrationRecord>(MIGRATIONS_COLLECTION)
    .find({ _id: { $ne: MIGRATIONS_LOCK_ID } })
    .toArray();
  const appliedIds = new Map(records.map((r) => [r._id, r.appliedAt ?? new Date(0)]));
  const known = new Set(MIGRATIONS.map((m) => m.id));
  return {
    applied: MIGRATIONS.filter((m) => appliedIds.has(m.id)).map((m) => ({ id: m.id, appliedAt: appliedIds.get(m.id)! })),
    pending: MIGRATIONS.filter((m) => !appliedIds.has(m.id)).map((m) => ({ id: m.id, description: m.description })),
    unknown: [...appliedIds.keys()].filter((id) => !known.has(id)),
  };
}
