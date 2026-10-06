// GENERATED — do not edit. Source: shared/src/limits.ts
// Edit the source, then run: node scripts/sync-shared.mjs

import { DEFAULT_PLAN } from "./enums";
import { MAX_FILE_MB_HARD_CAP, planLimitsSchema, type LimitsSettings, type PlanLimits } from "./settings/schemas";

type UserLimitsInput = {
  plan?: string | null;
  limitsOverride?: Partial<Record<keyof PlanLimits, number | boolean | null | undefined>> | null;
};

/**
 * A user's real limits: their plan's limits from settings, with any per-user override
 * from the admin panel on top. The file-size hard cap (Cloudinary free tier) always wins.
 */
export function effectivePlanLimits(user: UserLimitsInput, settings: LimitsSettings): PlanLimits {
  const base =
    settings.plans[user.plan ?? DEFAULT_PLAN] ?? settings.plans[DEFAULT_PLAN] ?? planLimitsSchema.parse({});

  const override = Object.fromEntries(
    Object.entries(user.limitsOverride ?? {}).filter(([, v]) => v !== undefined && v !== null),
  ) as Partial<PlanLimits>;

  const merged = { ...base, ...override };
  return { ...merged, maxFileMB: Math.min(merged.maxFileMB, MAX_FILE_MB_HARD_CAP) };
}

type QuotaInput = { quota?: { periodStart?: Date | null; minutesUsed?: number | null } | null };

/**
 * End of the monthly quota period that starts at `periodStart`: the same day and time one
 * calendar month later (UTC), clamped to the month's last day (Jan 31 → Feb 28/29).
 */
export function quotaPeriodEnd(periodStart: Date): Date {
  const y = periodStart.getUTCFullYear();
  const m = periodStart.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const end = new Date(periodStart);
  end.setUTCDate(1);
  end.setUTCMonth(m);
  end.setUTCDate(Math.min(periodStart.getUTCDate(), lastDay));
  return end;
}

/**
 * Minutes used in the user's CURRENT period. A period that has ended counts as 0 even
 * before anything resets the stored counter — the counter is rolled over when usage is
 * next charged (worker, transcription step).
 */
export function minutesUsedThisPeriod(user: QuotaInput, now = new Date()): number {
  const start = user.quota?.periodStart;
  if (!start || now >= quotaPeriodEnd(new Date(start))) return 0;
  return user.quota?.minutesUsed ?? 0;
}

/**
 * The start of the quota period `now` falls in. Periods keep their anniversary: a period
 * that began on the 15th rolls to the 15th of a later month, never to "today". With no
 * period yet, the first one starts now.
 */
export function currentQuotaPeriodStart(periodStart: Date | null | undefined, now = new Date()): Date {
  if (!periodStart) return now;
  let start = new Date(periodStart);
  // Bounded loop: one step per month since the last charge (years at most).
  for (let i = 0; i < 1200 && now >= quotaPeriodEnd(start); i++) start = quotaPeriodEnd(start);
  return start;
}

/**
 * When the minutes counter next starts again from 0 ("Resets Oct 29"). Follows the same
 * anniversary rule as charging (worker/src/pipeline/usage.ts). Null before the first
 * charge: the first video starts the first period.
 */
export function quotaResetsAt(user: QuotaInput, now = new Date()): Date | null {
  const start = user.quota?.periodStart;
  if (!start) return null;
  return quotaPeriodEnd(currentQuotaPeriodStart(new Date(start), now));
}

/** Whole minutes a video of this length counts against the monthly quota. */
export function billableMinutes(durationMs: number): number {
  return Math.max(1, Math.ceil(durationMs / 60_000));
}
