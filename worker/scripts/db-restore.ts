/**
 * Restores a backup into ANOTHER database (Step 17, D53).
 *
 *   npm run db:restore -- <file.ejson.gz> --into <database name>
 *   npm run db:restore -- --cloud latest --into <database name>      newest backup in Cloudinary
 *   npm run db:restore -- --cloud <public id> --into <database name>
 *   … add --drop to replace collections that already have documents
 *
 * It never restores into the database in worker/.env.local (MONGODB_DB) — restore into a new
 * name, look at it (`npm run db:restore` prints the counts), then point MONGODB_DB at it.
 * `--replace-live` lifts that rule and is for the day the live database is already lost.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";

import mongoose from "mongoose";

import { env } from "../src/config/env";
import { downloadBackup, listBackups } from "../src/backup/storage";
import { restoreBackup } from "../src/lib/backup";
import { connectDb, disconnectDb } from "../src/lib/db";
import { logger } from "../src/lib/logger";
import { runShutdownHooks } from "../src/lib/shutdown";

logger.level = "silent";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const into = arg("--into");
  if (!into) throw new Error("say where to restore: --into <database name>");
  if (into === env.MONGODB_DB && !process.argv.includes("--replace-live")) {
    throw new Error(`"${into}" is the live database in .env.local. Restore into a new name first (for example --into ${into}_restored), check it, then switch MONGODB_DB.`);
  }

  let file = process.argv[2] && !process.argv[2].startsWith("--") ? path.resolve(process.argv[2]) : undefined;
  const cloud = arg("--cloud");
  if (cloud) {
    await connectDb();
    const ids = await listBackups(env.MONGODB_DB);
    const id = cloud === "latest" ? ids.at(-1) : cloud;
    if (!id) throw new Error(`no backups of "${env.MONGODB_DB}" in Cloudinary`);
    const dir = path.join(env.SCRATCH_DIR, "backups");
    await mkdir(dir, { recursive: true });
    file = path.join(dir, path.basename(id));
    console.log(`\ndownloading ${id}`);
    await downloadBackup(id, file);
    await disconnectDb();
  }
  if (!file) throw new Error("say which backup: a file path, or --cloud latest");

  await connectDb({ dbName: into });
  console.log(`\nRestoring ${file}\n  into database "${into}"${process.argv.includes("--drop") ? " (replacing existing collections)" : ""}`);
  const summary = await restoreBackup(file, mongoose.connection.db!, { drop: process.argv.includes("--drop") });
  console.log(`\nbackup of "${summary.db}" taken ${summary.at}`);
  for (const [c, n] of Object.entries(summary.counts)) console.log(`  ${c.padEnd(16)} ${n}`);
  console.log(`${summary.docs} documents restored. Run \`npm run db:indexes\` against "${into}" before using it.\n`);
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
