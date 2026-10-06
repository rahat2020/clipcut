import type { Types } from "mongoose";

import {
  currentQuotaPeriodStart,
  isDuplicateKeyError,
  transcribeChargeKey,
  User,
  UsageEvent,
} from "../shared";

/**
 * Charges a video's processing minutes, exactly once per video (docs/DECISIONS.md D33):
 *
 * 1. Append to the `usage_events` ledger with a unique idempotency key. A retried job,
 *    a resumed run or a user Retry hits the unique index and charges nothing.
 * 2. Then bump the fast counter `users.quota.minutesUsed`, rolling the monthly period
 *    forward first if it ended. The period update is guarded on the old value, so two
 *    charges racing across a period boundary can't both reset it.
 *
 * Ledger first: if we crash between the two steps the counter is low, never double.
 * Returns false when this video was already charged.
 */
export async function chargeMinutes(args: {
  userId: Types.ObjectId;
  videoId: Types.ObjectId;
  minutes: number;
  provider: string;
  model: string;
  now?: Date;
}): Promise<boolean> {
  const now = args.now ?? new Date();
  try {
    await UsageEvent.create({
      userId: args.userId,
      videoId: args.videoId,
      type: "transcribe",
      quantity: args.minutes,
      unit: "minutes",
      provider: args.provider,
      model: args.model,
      idempotencyKey: transcribeChargeKey(args.videoId),
      at: now,
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) return false;
    throw err;
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const user = await User.findById(args.userId).select({ quota: 1 }).lean();
    if (!user) return true; // account gone; the ledger still has the charge
    const oldStart = user.quota?.periodStart ?? null;
    const start = currentQuotaPeriodStart(oldStart, now);

    if (oldStart && start.getTime() === new Date(oldStart).getTime()) {
      await User.updateOne({ _id: args.userId }, { $inc: { "quota.minutesUsed": args.minutes } });
      return true;
    }
    // New period (or first ever): reset the counter to this charge — guarded on the old start.
    const res = await User.updateOne(
      { _id: args.userId, "quota.periodStart": oldStart },
      { $set: { "quota.periodStart": start, "quota.minutesUsed": args.minutes } },
    );
    if (res.modifiedCount === 1) return true;
  }
  // Lost three races in a row; the ledger has the truth, and the counter is fixed on the next charge.
  return true;
}
