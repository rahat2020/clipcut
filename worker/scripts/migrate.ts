/**
 * Applies pending database migrations.
 *
 *   npm run migrate            apply pending migrations
 *   npm run migrate -- --status   list applied / pending, change nothing
 *
 * Deploy order when a migration is involved: migrate → tolerant readers → writers
 * (docs/SCHEMA.md §6.4).
 */
import mongoose from "mongoose";

import { env } from "../src/config/env";
import { connectDb, disconnectDb } from "../src/lib/db";
import { migrationStatus, runMigrations } from "../src/lib/migrations";

async function main() {
  await connectDb({ autoIndex: false });
  const db = mongoose.connection.db!;
  console.log(`\nDatabase "${env.MONGODB_DB}" on ${mongoose.connection.host}\n`);

  if (process.argv.includes("--status")) {
    const s = await migrationStatus(db);
    for (const a of s.applied) console.log(`✓ ${a.id}  (applied ${a.appliedAt.toISOString()})`);
    for (const p of s.pending) console.log(`○ ${p.id}  — ${p.description}`);
    for (const u of s.unknown) console.log(`⚠ ${u}  — in database, missing from code`);
    console.log(`\n${s.applied.length} applied, ${s.pending.length} pending\n`);
    return;
  }

  const applied = await runMigrations(db, (m) => console.log(m));
  console.log(applied.length ? `\n${applied.length} migration(s) applied\n` : "Nothing to do — database is up to date\n");
}

main()
  .catch((err: unknown) => {
    console.error(`✗ migration failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb().catch(() => {}));
