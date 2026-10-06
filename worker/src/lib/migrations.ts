import os from "node:os";

import type mongoose from "mongoose";

import { MIGRATIONS } from "../shared/migrations";

/**
 * Applies pending migrations in order and records each in `_migrations`
 * (docs/SCHEMA.md §6.4). A lock document stops two runs from overlapping.
 */

type Db = mongoose.mongo.Db;
type MigrationRecord = { _id: string; description?: string; appliedAt?: Date; durationMs?: number; at?: Date; by?: string };

const COLLECTION = "_migrations";
const LOCK_ID = "__lock";
/** A lock older than this is assumed to be from a crashed run and is taken over. */
const STALE_LOCK_MS = 15 * 60 * 1000;

export type MigrationStatus = {
  applied: { id: string; appliedAt: Date }[];
  pending: { id: string; description: string }[];
  /** In the database but not in code — someone deleted or renamed a migration. */
  unknown: string[];
};

export async function migrationStatus(db: Db): Promise<MigrationStatus> {
  const records = await db
    .collection<MigrationRecord>(COLLECTION)
    .find({ _id: { $ne: LOCK_ID } })
    .toArray();
  const appliedIds = new Map(records.map((r) => [r._id, r.appliedAt ?? new Date(0)]));
  const known = new Set(MIGRATIONS.map((m) => m.id));
  return {
    applied: MIGRATIONS.filter((m) => appliedIds.has(m.id)).map((m) => ({ id: m.id, appliedAt: appliedIds.get(m.id)! })),
    pending: MIGRATIONS.filter((m) => !appliedIds.has(m.id)).map((m) => ({ id: m.id, description: m.description })),
    unknown: [...appliedIds.keys()].filter((id) => !known.has(id)),
  };
}

async function acquireLock(db: Db, owner: string): Promise<void> {
  const col = db.collection<MigrationRecord>(COLLECTION);
  try {
    await col.insertOne({ _id: LOCK_ID, at: new Date(), by: owner });
    return;
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err;
  }
  const lock = await col.findOne({ _id: LOCK_ID });
  const age = Date.now() - (lock?.at?.getTime() ?? 0);
  if (age < STALE_LOCK_MS) {
    throw new Error(`another migration run holds the lock (${lock?.by}, ${Math.round(age / 1000)} s ago)`);
  }
  const res = await col.updateOne({ _id: LOCK_ID, at: lock?.at }, { $set: { at: new Date(), by: owner } });
  if (res.modifiedCount !== 1) throw new Error("lost the race for a stale migration lock — try again");
}

async function releaseLock(db: Db, owner: string): Promise<void> {
  await db.collection<MigrationRecord>(COLLECTION).deleteOne({ _id: LOCK_ID, by: owner });
}

/** Runs every pending migration. Returns the ids it applied. */
export async function runMigrations(db: Db, log: (message: string) => void): Promise<string[]> {
  const owner = `${os.hostname()}:${process.pid}`;
  await acquireLock(db, owner);
  const appliedNow: string[] = [];
  try {
    const { pending, unknown } = await migrationStatus(db);
    if (unknown.length > 0) log(`⚠ applied in the database but missing from code: ${unknown.join(", ")}`);

    for (const { id } of pending) {
      const migration = MIGRATIONS.find((m) => m.id === id)!;
      log(`→ ${id}: ${migration.description}`);
      const started = Date.now();
      await migration.up({ db, log: (m) => log(`    ${m}`) });
      const durationMs = Date.now() - started;
      await db
        .collection<MigrationRecord>(COLLECTION)
        .insertOne({ _id: id, description: migration.description, appliedAt: new Date(), durationMs });
      log(`✓ ${id} (${durationMs} ms)`);
      appliedNow.push(id);
    }
  } finally {
    await releaseLock(db, owner);
  }
  return appliedNow;
}
