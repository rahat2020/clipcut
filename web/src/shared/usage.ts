// GENERATED — do not edit. Source: shared/src/usage.ts
// Edit the source, then run: node scripts/sync-shared.mjs

import type { Types } from "mongoose";

import { UsageEvent } from "./models";

/**
 * The ledger key of the one minutes charge a video can ever have (docs/DECISIONS.md D33). The
 * unique index on `usage_events.idempotencyKey` is what makes a retried job, a resumed run, a user
 * Retry or an admin re-run unable to charge twice.
 */
export function transcribeChargeKey(videoId: Types.ObjectId | string): string {
  return `video:${String(videoId)}:transcribe`;
}

/**
 * True once this video's minutes have been charged. A video that was charged must never be
 * refused for lack of minutes when it is retried or re-run: it can't be charged again, and the
 * minutes it already used would otherwise be counted against it a second time (Step 17).
 */
export async function videoWasCharged(videoId: Types.ObjectId | string): Promise<boolean> {
  return (await UsageEvent.exists({ idempotencyKey: transcribeChargeKey(videoId) })) !== null;
}
