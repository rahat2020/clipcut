import { Types } from "mongoose";

import { logger } from "../lib/logger";
import { isRateLimited, type StoredVideo } from "../services/storage/cleanup-storage";
import {
  AnalysisRun,
  CLEANUP_TIMING,
  Clip,
  DEFAULT_PLAN,
  expiryCandidatesFilter,
  getSettings,
  isExpired,
  Render,
  TERMINAL_VIDEO_STATUSES,
  Transcript,
  User,
  Video,
} from "../shared";

/**
 * The cleanup job (Step 17, docs/SCHEMA.md §8 and D51). Four database-driven sweeps and one
 * Cloudinary-wide scan, each bounded and each safe to run twice:
 *
 *   abandoned  a draft (upload ticket made, never finished) older than 48 h → soft-deleted
 *   deleted    a video the user deleted whose files are still there (the delete's own attempt
 *              failed) → files removed, `retention.assetsDeletedAt` set
 *   expired    a finished video past its retention (shared `isExpired`, the owner's plan) →
 *              files removed, `assetsDeletedAt` set; the video stays as an archive
 *   purge      a deleted video whose files are gone and that was deleted more than
 *              `purgeSoftDeletedAfterDays` ago → its documents are removed (the usage ledger stays)
 *   orphans    files in Cloudinary that no live video owns (scan, once a day)
 *
 * `assetsDeletedAt` is only set after Cloudinary confirmed, so a failure is simply retried by the
 * next run. A rate-limited Cloudinary stops the run at once.
 */

export type CleanupDeps = {
  deleteVideoFiles: (userId: string, videoId: string) => Promise<void>;
  listStoredVideos: (opts: { maxPages?: number }) => Promise<StoredVideo[]>;
};

export type CleanupOptions = {
  /** Only report what would be done. */
  dryRun?: boolean;
  /** Also scan Cloudinary for orphaned files (the daily one). */
  orphans?: boolean;
  now?: Date;
};

export type CleanupReport = {
  dryRun: boolean;
  abandoned: string[];
  deleted: string[];
  expired: string[];
  purged: string[];
  orphans: string[];
  /** Orphans found beyond the per-scan limit (left for the next scan). */
  moreOrphans: number;
  failed: number;
  /** Why a part didn't run (rate limit, empty database…). */
  notes: string[];
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

class RateLimitedStop extends Error {}

export async function runCleanup(deps: CleanupDeps, options: CleanupOptions = {}): Promise<CleanupReport> {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun ?? false;
  const report: CleanupReport = { dryRun, abandoned: [], deleted: [], expired: [], purged: [], orphans: [], moreOrphans: 0, failed: 0, notes: [] };

  /** Deletes a video's files; false (and counted) on a failure, RateLimitedStop on Cloudinary's limit. */
  const removeFiles = async (userId: string, videoId: string): Promise<boolean> => {
    try {
      await deps.deleteVideoFiles(userId, videoId);
      return true;
    } catch (err) {
      if (isRateLimited(err)) throw new RateLimitedStop();
      report.failed++;
      logger.warn({ err, videoId }, "cleanup: couldn't delete a video's files — will retry next run");
      return false;
    }
  };

  try {
    await abandonedDrafts(report, now, dryRun);
    await deletedVideos(report, removeFiles, now, dryRun);
    await expiredVideos(report, removeFiles, now, dryRun);
    await purgeDeleted(report, now, dryRun);
    if (options.orphans) await orphanFiles(report, deps, removeFiles, now, dryRun);
  } catch (err) {
    if (!(err instanceof RateLimitedStop)) throw err;
    report.notes.push("Cloudinary asked us to slow down — stopped, the rest happens on the next run");
  }
  return report;
}

type Remover = (userId: string, videoId: string) => Promise<boolean>;

async function abandonedDrafts(report: CleanupReport, now: Date, dryRun: boolean): Promise<void> {
  const before = new Date(now.getTime() - CLEANUP_TIMING.abandonedDraftHours * HOUR_MS);
  const drafts = await Video.find({ status: "draft", deletedAt: null, createdAt: { $lt: before } })
    .limit(CLEANUP_TIMING.batch)
    .select({ _id: 1 })
    .lean();
  report.abandoned = drafts.map((v) => String(v._id));
  // Soft delete only: the "deleted" sweep then removes any file the half-finished upload left.
  if (!dryRun && drafts.length > 0) {
    await Video.updateMany({ _id: { $in: drafts.map((v) => v._id) }, status: "draft", deletedAt: null }, { $set: { deletedAt: now } });
  }
}

async function deletedVideos(report: CleanupReport, removeFiles: Remover, now: Date, dryRun: boolean): Promise<void> {
  const videos = await Video.find({ deletedAt: { $ne: null }, "retention.assetsDeletedAt": null })
    .sort({ deletedAt: 1 })
    .limit(CLEANUP_TIMING.batch)
    .select({ _id: 1, userId: 1 })
    .lean();
  for (const v of videos) {
    if (dryRun) {
      report.deleted.push(String(v._id));
      continue;
    }
    if (!(await removeFiles(String(v.userId), String(v._id)))) continue;
    await Video.updateOne({ _id: v._id }, { $set: { "retention.assetsDeletedAt": now } });
    report.deleted.push(String(v._id));
  }
}

async function expiredVideos(report: CleanupReport, removeFiles: Remover, now: Date, dryRun: boolean): Promise<void> {
  const retention = await getSettings("retention");
  // Only finished videos: one that is queued or processing again (Find new clips) is left alone.
  const candidates = await Video.find({
    ...expiryCandidatesFilter(retention, now),
    deletedAt: null,
    status: { $in: [...TERMINAL_VIDEO_STATUSES] },
  })
    .sort({ "retention.finishedAt": 1 })
    .limit(CLEANUP_TIMING.batch)
    .select({ _id: 1, userId: 1, retention: 1 })
    .lean();
  if (candidates.length === 0) return;

  const owners = await User.find({ _id: { $in: [...new Set(candidates.map((v) => String(v.userId)))].map((id) => new Types.ObjectId(id)) } })
    .select({ plan: 1 })
    .lean();
  const planOf = new Map(owners.map((u) => [String(u._id), u.plan ?? DEFAULT_PLAN]));

  for (const v of candidates) {
    // The owner's CURRENT plan and the CURRENT settings, through the one shared rule.
    if (!isExpired(v, planOf.get(String(v.userId)) ?? DEFAULT_PLAN, retention, now)) continue;
    if (dryRun) {
      report.expired.push(String(v._id));
      continue;
    }
    if (!(await removeFiles(String(v.userId), String(v._id)))) continue;
    await Video.updateOne({ _id: v._id, "retention.assetsDeletedAt": null }, { $set: { "retention.assetsDeletedAt": now } });
    report.expired.push(String(v._id));
  }
}

async function purgeDeleted(report: CleanupReport, now: Date, dryRun: boolean): Promise<void> {
  const retention = await getSettings("retention");
  const before = new Date(now.getTime() - retention.purgeSoftDeletedAfterDays * DAY_MS);
  const videos = await Video.find({ deletedAt: { $lt: before }, "retention.assetsDeletedAt": { $ne: null } })
    .limit(CLEANUP_TIMING.batch)
    .select({ _id: 1 })
    .lean();
  for (const v of videos) {
    if (!dryRun) {
      // The usage ledger (usage_events) stays: it is the record of what the user was charged.
      await Promise.all([
        Clip.deleteMany({ videoId: v._id }),
        Transcript.deleteMany({ videoId: v._id }),
        AnalysisRun.deleteMany({ videoId: v._id }),
        Render.deleteMany({ videoId: v._id }),
      ]);
      await Video.deleteOne({ _id: v._id, deletedAt: { $lt: before } });
    }
    report.purged.push(String(v._id));
  }
}

/**
 * Files in Cloudinary that no live video owns: no video document at all, or one whose files are
 * already marked deleted (a render uploaded by a job that was canceled, a failed earlier delete).
 * Guards: never on an empty database (a wrong connection must not look like "everything is an
 * orphan"), never a video whose newest file is under a day old, at most `maxOrphanVideos` per scan.
 */
async function orphanFiles(report: CleanupReport, deps: CleanupDeps, removeFiles: Remover, now: Date, dryRun: boolean): Promise<void> {
  // exists(), not a count: a count can lag after deletions, and this guard must be exact.
  if (!(await Video.exists({}))) {
    report.notes.push("the database has no videos at all — orphan scan skipped (wrong database?)");
    return;
  }
  const minAge = CLEANUP_TIMING.orphanMinAgeHours * HOUR_MS;
  const stored = (await deps.listStoredVideos({ maxPages: CLEANUP_TIMING.maxListPages })).filter((s) => now.getTime() - s.newestAt.getTime() >= minAge);
  if (stored.length === 0) return;

  const known = await Video.find({ _id: { $in: stored.map((s) => new Types.ObjectId(s.videoId)) } })
    .select({ _id: 1, retention: 1 })
    .lean();
  const live = new Set(known.filter((v) => !v.retention?.assetsDeletedAt).map((v) => String(v._id)));
  const orphans = stored.filter((s) => !live.has(s.videoId));

  report.moreOrphans = Math.max(0, orphans.length - CLEANUP_TIMING.maxOrphanVideos);
  for (const o of orphans.slice(0, CLEANUP_TIMING.maxOrphanVideos)) {
    if (!dryRun && !(await removeFiles(o.userId, o.videoId))) continue;
    report.orphans.push(o.videoId);
  }
}
