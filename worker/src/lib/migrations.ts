import os from "node:os";

import type mongoose from "mongoose";

import { MIGRATIONS } from "../shared/migrations";
import { migrationStatus, MIGRATIONS_COLLECTION as COLLECTION, MIGRATIONS_LOCK_ID as LOCK_ID, type MigrationRecord } from "../shared/migrations/status";

/**
 * Applies pending migrations in order and records each in `_migrations`
 * (docs/SCHEMA.md §6.4). A lock document stops two runs from overlapping.
 * `migrationStatus` lives in shared/ — the admin System page shows the same thing.
 */

export { migrationStatus };
export type { MigrationStatus } from "../shared/migrations/status";

type Db = mongoose.mongo.Db;

/** A lock older than this is assumed to be from a crashed run and is taken over. */
const STALE_LOCK_MS = 15 * 60 * 1000;

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
