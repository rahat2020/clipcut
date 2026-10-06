import { WORKER_ID } from "../lib/presence";
import { logger } from "../lib/logger";
import { redis } from "../lib/redis";
import { deleteVideoFiles, listStoredVideos } from "../services/storage/cleanup-storage";
import { CLEANUP_TIMING, getSettings } from "../shared";
import { runCleanup, type CleanupReport } from "./cleanup";

/**
 * One scheduled cleanup run: honours the kill switch (`settings.system.cleanupEnabled`) and holds
 * a Redis lock so two workers on the same database never clean at once. Returns null when it
 * didn't run. Logs one line with what was done (nothing is logged for an empty run).
 */
const LOCK_KEY = "cleanup:lock";

export async function scheduledCleanup(options: { orphans: boolean }): Promise<CleanupReport | null> {
  const system = await getSettings("system");
  if (!system.cleanupEnabled) return null;

  const got = await redis().set(LOCK_KEY, WORKER_ID, "EX", CLEANUP_TIMING.lockSeconds, "NX");
  if (got !== "OK") return null;
  try {
    const report = await runCleanup({ deleteVideoFiles, listStoredVideos }, { orphans: options.orphans });
    const counts = {
      abandoned: report.abandoned.length,
      deleted: report.deleted.length,
      expired: report.expired.length,
      purged: report.purged.length,
      orphans: report.orphans.length,
      moreOrphans: report.moreOrphans,
      failed: report.failed,
    };
    if (Object.values(counts).some((n) => n > 0) || report.notes.length > 0) logger.info({ ...counts, notes: report.notes }, "cleanup finished");
    return report;
  } finally {
    await redis().del(LOCK_KEY).catch(() => {});
  }
}
