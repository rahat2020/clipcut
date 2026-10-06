/**
 * Runs the cleanup job once by hand (Step 17).
 *
 *   npm run cleanup:run                 dry run: only lists what WOULD be deleted (default)
 *   npm run cleanup:run -- --orphans    …and scans Cloudinary for files no video owns
 *   npm run cleanup:run -- --apply      really delete (add --orphans for the scan too)
 *
 * Uses the real database and the real Cloudinary folder from worker/.env.local. A dry run reads
 * Cloudinary's file list (a few Admin API calls) but changes nothing anywhere.
 */
import { runCleanup } from "../src/cleanup/cleanup";
import { connectDb, disconnectDb } from "../src/lib/db";
import { logger } from "../src/lib/logger";
import { runShutdownHooks } from "../src/lib/shutdown";
import { deleteVideoFiles, listStoredVideos } from "../src/services/storage/cleanup-storage";
import { env } from "../src/config/env";

logger.level = "silent";

async function main() {
  const apply = process.argv.includes("--apply");
  const orphans = process.argv.includes("--orphans");
  console.log(`\nCleanup ${apply ? "— DELETING for real" : "(dry run, nothing is changed)"} · database "${env.MONGODB_DB}" · Cloudinary folder "${env.CLOUDINARY_FOLDER}"${orphans ? " · with the orphan scan" : ""}\n`);
  await connectDb();
  try {
    const r = await runCleanup({ deleteVideoFiles, listStoredVideos }, { dryRun: !apply, orphans });
    const show = (label: string, ids: string[]) => console.log(`${label.padEnd(34)} ${ids.length}${ids.length ? `  ${ids.slice(0, 5).join(", ")}${ids.length > 5 ? " …" : ""}` : ""}`);
    show(apply ? "abandoned drafts (soft-deleted)" : "abandoned drafts (would be deleted)", r.abandoned);
    show(apply ? "deleted videos — files removed" : "deleted videos — files to remove", r.deleted);
    show(apply ? "expired videos — files removed" : "expired videos — files to remove", r.expired);
    show(apply ? "purged (documents removed)" : "to purge (documents)", r.purged);
    if (orphans) show(apply ? "orphaned files removed" : "orphaned files found", r.orphans);
    if (r.moreOrphans) console.log(`${"more orphans for the next scan".padEnd(34)} ${r.moreOrphans}`);
    if (r.failed) console.log(`${"failed (retried next run)".padEnd(34)} ${r.failed}`);
    for (const n of r.notes) console.log(`note: ${n}`);
    console.log("");
  } finally {
    await disconnectDb().catch(() => {});
    await runShutdownHooks(() => {});
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
