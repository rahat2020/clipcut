/**
 * Backs up the whole database to one file (Step 17, D53).
 *
 *   npm run db:backup                    → D:\backups\clipcut-<db>-<date>.ejson.gz   (./backups on Linux)
 *   npm run db:backup -- --out <folder>  → another folder
 *   npm run db:backup -- --cloud         → also upload it to Cloudinary (what the worker does daily)
 *   npm run db:backup -- --keep 14       → keep the newest 14 files in the folder (default 14)
 *
 * Reads only; never changes the database. Restore with `npm run db:restore`.
 */
import { readdir, rm, stat, mkdir } from "node:fs/promises";
import path from "node:path";

import mongoose from "mongoose";

import { env } from "../src/config/env";
import { deleteBackup, listBackups, uploadBackup } from "../src/backup/storage";
import { backupFileName, backupsToDelete, writeBackup } from "../src/lib/backup";
import { connectDb, disconnectDb } from "../src/lib/db";
import { logger } from "../src/lib/logger";
import { runShutdownHooks } from "../src/lib/shutdown";
import { BACKUP_TIMING } from "../src/shared";

logger.level = "silent";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const out = path.resolve(arg("--out") ?? (process.platform === "win32" ? "D:\\backups" : "backups"));
  const keep = Number(arg("--keep") ?? 14);
  await connectDb();
  const db = mongoose.connection.db!;
  await mkdir(out, { recursive: true });
  const name = backupFileName(db.databaseName, new Date());
  const file = path.join(out, name);

  console.log(`\nBacking up database "${db.databaseName}" → ${file}`);
  const summary = await writeBackup(db, file);
  const { size } = await stat(file);
  for (const [c, n] of Object.entries(summary.counts)) console.log(`  ${c.padEnd(16)} ${n}`);
  console.log(`${summary.docs} documents · ${(size / 1024).toFixed(0)} KB`);

  if (process.argv.includes("--cloud")) {
    const { publicId } = await uploadBackup(file, name, db.databaseName);
    for (const id of backupsToDelete(await listBackups(db.databaseName), BACKUP_TIMING.keep)) await deleteBackup(id).catch(() => {});
    console.log(`uploaded to Cloudinary: ${publicId}`);
  }

  // Keep the newest `keep` files of THIS database in the folder.
  const mine = (await readdir(out)).filter((f) => f.startsWith(`clipcut-${db.databaseName}-`) && f.endsWith(".ejson.gz"));
  for (const old of backupsToDelete(mine, keep)) await rm(path.join(out, old), { force: true });
  console.log(`kept the newest ${Math.min(keep, mine.length)} in ${out}\n`);
  void env;
}

main()
  .catch((err: unknown) => {
    console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectDb().catch(() => {});
    await runShutdownHooks(() => {});
  });
