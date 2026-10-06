import { DEFAULT_PLAN } from "./enums";
import type { RetentionSettings } from "./settings/schemas";

/**
 * The only place the retention rule lives (docs/SCHEMA.md §8). The UI, API and cleanup
 * job all call these, so they can never disagree.
 *
 * Expiry is computed from the CURRENT settings every time — never stored — so changing
 * the days in the admin panel applies to old and new videos alike.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type VideoRetention = {
  retention?: {
    finishedAt?: Date | null;
    expireOverrideAt?: Date | null;
    assetsDeletedAt?: Date | null;
  } | null;
};

export function retentionDaysForPlan(settings: RetentionSettings, plan: string): number {
  const days = settings.plans[plan]?.days ?? settings.plans[DEFAULT_PLAN]?.days;
  if (days === undefined) throw new Error(`retention settings have no "${DEFAULT_PLAN}" plan`);
  return days;
}

/**
 * When this video's files will be deleted, or null while it's still processing.
 *
 *   override set by an admin                         → that date
 *   otherwise → max( finishedAt + plan days,
 *                    retention change time + grace )  ← shortening never deletes instantly
 */
export function effectiveExpiry(video: VideoRetention, ownerPlan: string, settings: RetentionSettings): Date | null {
  const r = video.retention;
  if (r?.expireOverrideAt) return new Date(r.expireOverrideAt);
  if (!r?.finishedAt) return null;

  const byPlan = new Date(r.finishedAt).getTime() + retentionDaysForPlan(settings, ownerPlan) * DAY_MS;
  const graceFloor = settings.changedAt ? new Date(settings.changedAt).getTime() + settings.graceHours * HOUR_MS : 0;
  return new Date(Math.max(byPlan, graceFloor));
}

/** True once the files are due for deletion (or already deleted). */
export function isExpired(video: VideoRetention, ownerPlan: string, settings: RetentionSettings, now = new Date()): boolean {
  if (video.retention?.assetsDeletedAt) return true;
  const expiry = effectiveExpiry(video, ownerPlan, settings);
  return expiry !== null && expiry.getTime() <= now.getTime();
}

/**
 * MongoDB filter for videos that MIGHT be expired — the cleanup job checks each one with
 * `isExpired` using its owner's plan. Uses the shortest retention across all plans, plus
 * admin overrides that can be earlier than any plan.
 */
export function expiryCandidatesFilter(settings: RetentionSettings, now = new Date()) {
  const shortestDays = Math.min(...Object.values(settings.plans).map((p) => p.days));
  return {
    "retention.assetsDeletedAt": null,
    $or: [
      { "retention.finishedAt": { $lt: new Date(now.getTime() - shortestDays * DAY_MS) } },
      { "retention.expireOverrideAt": { $lte: now } },
    ],
  };
}
