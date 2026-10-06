/**
 * Who may upload what. Pure functions (no I/O) so the same rules run before the upload
 * (with the browser's numbers, for a fast "no") and after it (with Cloudinary's numbers,
 * which are the ones that count) — and so scripts/upload-smoke-test.ts can test them.
 */
import { AppError, billableMinutes, minutesUsedThisPeriod, type PlanLimits, type SettingsOf } from "@/shared";

type RulesUser = { quota?: { periodStart?: Date | null; minutesUsed?: number | null } | null };

export type UploadFacts = {
  /** Size in bytes (browser-reported before upload, Cloudinary's after). */
  bytes: number;
  /** Length in ms, when known. The browser can't always read it; Cloudinary always can. */
  durationMs?: number | null;
};

export function assertUploadsOpen(system: SettingsOf<"system">): void {
  if (!system.uploadsEnabled) throw new AppError("UPLOADS_DISABLED");
}

/**
 * Throws the AppError that explains the first rule this upload breaks:
 * FILE_TOO_LARGE, VIDEO_TOO_LONG, QUOTA_EXCEEDED or CONCURRENCY_LIMIT.
 */
export function assertUploadAllowed(args: {
  user: RulesUser;
  limits: PlanLimits;
  facts: UploadFacts;
  activeJobs: number;
  now?: Date;
}): void {
  const { user, limits, facts, activeJobs } = args;
  const now = args.now ?? new Date();

  const maxBytes = limits.maxFileMB * 1024 * 1024;
  if (facts.bytes > maxBytes) {
    throw new AppError("FILE_TOO_LARGE", {
      message: `This file is larger than ${limits.maxFileMB} MB, the most your plan allows.`,
      details: { bytes: facts.bytes, maxBytes },
    });
  }

  if (facts.durationMs != null) {
    const maxMs = limits.maxDurationMin * 60_000;
    if (facts.durationMs > maxMs) {
      throw new AppError("VIDEO_TOO_LONG", {
        message: `This video is longer than ${limits.maxDurationMin} minutes, the most your plan allows.`,
        details: { durationMs: facts.durationMs, maxMs },
      });
    }

    const remaining = limits.monthlyMinutes - minutesUsedThisPeriod(user, now);
    const needed = billableMinutes(facts.durationMs);
    if (needed > remaining) {
      throw new AppError("QUOTA_EXCEEDED", {
        message:
          remaining > 0
            ? `This video needs ${needed} minutes, but you have ${remaining} left this month.`
            : "You've used all your processing minutes for this month.",
        details: { needed, remaining },
      });
    }
  }

  if (activeJobs >= limits.concurrentJobs) {
    throw new AppError("CONCURRENCY_LIMIT", {
      message:
        limits.concurrentJobs === 1
          ? "You already have a video processing. Try again when it finishes."
          : `You already have ${activeJobs} videos processing. Try again when one finishes.`,
    });
  }
}

/** A title from the file name: extension and separators removed, trimmed to 300 chars. */
export function titleFromFilename(filename: string): string {
  const base = filename.replace(/\.[^./\\]+$/, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
  return (base || "Untitled video").slice(0, 300);
}
