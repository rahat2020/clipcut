/**
 * What a retention change does to videos that exist today (docs/ADMIN.md — Retention).
 * Pure: the caller loads the videos. Expiry is computed (never stored), so a change reaches
 * every video that still has files — this tells the admin how many before they confirm.
 */
import { DEFAULT_PLAN, effectiveExpiry, type RetentionSettings } from "@/shared";

export type ImpactVideo = { userId: string; plan: string; finishedAt: Date };

export type RetentionImpact = {
  /** Videos whose files are still stored and follow their plan's rule (no per-video override). */
  videos: number;
  /** Those whose deletion date changes at all. */
  changed: number;
  /** …of which will be deleted EARLIER than today's rule says. */
  shortened: number;
  /** …of which will be kept LONGER. */
  lengthened: number;
  /** Shortened videos already past the new deadline: the next cleanup run deletes them (after the grace). */
  dueAtOnce: number;
  /** Earliest deletion date among the shortened videos, or null. */
  earliest: Date | null;
  /** Distinct owners with a shortened video. */
  usersAffected: number;
};

const same = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);

export function retentionImpact(videos: readonly ImpactVideo[], before: RetentionSettings, after: RetentionSettings, now: Date): RetentionImpact {
  const impact: RetentionImpact = { videos: videos.length, changed: 0, shortened: 0, lengthened: 0, dueAtOnce: 0, earliest: null, usersAffected: 0 };
  const users = new Set<string>();
  // A video already past its date is deleted at the next cleanup run, i.e. "now": compare on that
  // basis, or an overdue video that stays due would count as "kept longer".
  const atLeastNow = (d: Date | null) => (d ? new Date(Math.max(d.getTime(), now.getTime())) : null);
  for (const v of videos) {
    const r = { retention: { finishedAt: v.finishedAt } };
    const was = atLeastNow(effectiveExpiry(r, v.plan, before));
    const will = atLeastNow(effectiveExpiry(r, v.plan, after));
    if (!was || !will || same(was, will)) continue;
    impact.changed++;
    if (will.getTime() < was.getTime()) {
      impact.shortened++;
      users.add(v.userId);
      if (will.getTime() <= now.getTime()) impact.dueAtOnce++;
      if (!impact.earliest || will.getTime() < impact.earliest.getTime()) impact.earliest = will;
    } else {
      impact.lengthened++;
    }
  }
  impact.usersAffected = users.size;
  return impact;
}

/**
 * What the admin must type to confirm a change that deletes sooner, or null when nothing
 * is deleted sooner. It's the new value of the setting that shortened (docs/ADMIN.md): the
 * shortest new "days" of a shortened plan, else the new purge days, else the grace hours.
 */
export function requiredRetentionConfirmation(
  before: RetentionSettings,
  after: RetentionSettings,
  impact: Pick<RetentionImpact, "shortened">,
  purgeDue: number,
): string | null {
  const shortenedPlans = Object.entries(after.plans)
    .filter(([plan, p]) => p.days < (before.plans[plan]?.days ?? before.plans[DEFAULT_PLAN]?.days ?? Infinity))
    .map(([, p]) => p.days);
  if (impact.shortened > 0) {
    return String(shortenedPlans.length > 0 ? Math.min(...shortenedPlans) : after.graceHours);
  }
  if (purgeDue > 0 && after.purgeSoftDeletedAfterDays < before.purgeSoftDeletedAfterDays) return String(after.purgeSoftDeletedAfterDays);
  return null;
}
