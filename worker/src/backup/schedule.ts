import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import mongoose from "mongoose";

import { env } from "../config/env";
import { backupFileName, backupsToDelete, writeBackup, type BackupSummary } from "../lib/backup";
import { logger } from "../lib/logger";
import { WORKER_ID } from "../lib/presence";
import { redis } from "../lib/redis";
import { BACKUP_TIMING, getSettings, type LastBackup } from "../shared";
import { deleteBackup, listBackups, uploadBackup } from "./storage";

/**
 * The daily database backup (Step 17, D53): the worker checks every few hours whether the last
 * good backup is older than a day, and if so writes one to Cloudinary and trims to the newest 7.
 * Redis holds a lock (one at a time) and `backup:last`, the last result — Redis has no persistence
 * on the free plan, so after a Redis wipe a backup simply runs again, which is harmless.
 * A failure is logged loudly and recorded; the next check retries.
 */

export type { LastBackup };

export async function readLastBackup(): Promise<LastBackup | null> {
  try {
    const raw = await redis().get(BACKUP_TIMING.lastKey);
    return raw ? (JSON.parse(raw) as LastBackup) : null;
  } catch {
    return null;
  }
}

/** Runs a backup if one is due. Returns what happened, or null when nothing was due / it is switched off. */
export async function scheduledBackup(now = new Date()): Promise<LastBackup | null> {
  const system = await getSettings("system");
  if (!system.backupEnabled) return null;

  const last = await readLastBackup();
  if (last && !last.error && now.getTime() - new Date(last.at).getTime() < BACKUP_TIMING.minGapMs) return null;

  const got = await redis().set(BACKUP_TIMING.lockKey, WORKER_ID, "EX", BACKUP_TIMING.lockSeconds, "NX");
  if (got !== "OK") return null;

  const db = mongoose.connection.db;
  if (!db) return null;
  const dir = path.join(env.SCRATCH_DIR, "backups");
  const name = backupFileName(db.databaseName, now);
  const file = path.join(dir, name);
  try {
    await mkdir(dir, { recursive: true });
    const summary: BackupSummary = await writeBackup(db, file, now);
    const { bytes } = await uploadBackup(file, name, db.databaseName);
    for (const id of backupsToDelete(await listBackups(db.databaseName), BACKUP_TIMING.keep)) await deleteBackup(id).catch(() => {});
    const result: LastBackup = { at: now.toISOString(), bytes, docs: summary.docs, file: name };
    await redis().set(BACKUP_TIMING.lastKey, JSON.stringify(result));
    logger.info({ file: name, bytes, docs: summary.docs }, "database backup saved to Cloudinary");
    return result;
  } catch (err) {
    const result: LastBackup = { at: now.toISOString(), error: err instanceof Error ? err.message : String(err) };
    await redis().set(BACKUP_TIMING.lastKey, JSON.stringify(result)).catch(() => {});
    logger.error({ err }, "DATABASE BACKUP FAILED — the database is not backed up until this is fixed");
    return result;
  } finally {
    await rm(file, { force: true }).catch(() => {});
    await redis().del(BACKUP_TIMING.lockKey).catch(() => {});
  }
}
