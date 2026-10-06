import {
  AppError,
  billableMinutes,
  effectivePlanLimits,
  getSettings,
  minutesUsedThisPeriod,
  User,
  type PlanLimits,
} from "../shared";
import type { RunVideo } from "./run";

export type RunUser = {
  plan?: string | null;
  limitsOverride?: Record<string, unknown> | null;
  quota?: { periodStart?: Date | null; minutesUsed?: number | null } | null;
};

/** The video owner's current limits (plan + admin override). */
export async function limitsFor(video: RunVideo): Promise<{ user: RunUser; limits: PlanLimits }> {
  const user = await User.findById(video.userId).select({ plan: 1, limitsOverride: 1, quota: 1 }).lean<RunUser>();
  if (!user) throw new AppError("NOT_FOUND", { message: "The account for this video no longer exists." });
  const limits = effectivePlanLimits(user as Parameters<typeof effectivePlanLimits>[0], await getSettings("limits"));
  return { user, limits };
}

/**
 * The same length and minutes-left rules as upload, applied to the real length. For
 * YouTube this is the first time we know it; for uploads it re-checks Cloudinary's number.
 */
export function assertLengthAllowed(durationMs: number, user: RunUser, limits: PlanLimits, now = new Date()): void {
  if (durationMs > limits.maxDurationMin * 60_000) {
    throw new AppError("VIDEO_TOO_LONG", {
      message: `This video is longer than ${limits.maxDurationMin} minutes, the most your plan allows.`,
    });
  }
  const remaining = limits.monthlyMinutes - minutesUsedThisPeriod(user, now);
  const needed = billableMinutes(durationMs);
  if (needed > remaining) {
    throw new AppError("QUOTA_EXCEEDED", {
      message:
        remaining > 0
          ? `This video needs ${needed} minutes, but you have ${remaining} left this month.`
          : "You've used all your processing minutes for this month.",
    });
  }
}
