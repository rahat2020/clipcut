import { redis } from "../../lib/redis";
import { aiCapKey, AppError, type AiCapMetric } from "../../shared";

/**
 * Our own daily ceilings per AI provider (settings.ai.dailyCaps), kept below the free
 * tiers so we never get throttled or banned. Counters live in Redis (docs/SCHEMA.md
 * §3.11): `ai:<provider>:<metric>:<YYYY-MM-DD UTC>`, expiring after 3 days. If Redis
 * restarts they reset to zero — briefly less strict, which is acceptable; the
 * usage_events ledger in MongoDB stays complete.
 */

export type CapMetric = AiCapMetric;

const TTL_SECONDS = 3 * 24 * 3600;

export const capKey = aiCapKey;

/**
 * Adds `amount` to today's counter, or throws AI_DAILY_CAP_REACHED (leaving the counter
 * unchanged) if that would pass `cap`. `prefix` is for tests.
 */
export async function reserveDailyCap(
  metric: CapMetric,
  amount: number,
  cap: number,
  options: { now?: Date; prefix?: string } = {},
): Promise<void> {
  const key = capKey(metric, options.now, options.prefix);
  const client = redis();
  const total = await client.incrby(key, Math.ceil(amount));
  if (total === Math.ceil(amount)) await client.expire(key, TTL_SECONDS);
  if (total > cap) {
    await client.decrby(key, Math.ceil(amount));
    throw new AppError("AI_DAILY_CAP_REACHED", { details: { metric, cap, wouldBe: total } });
  }
}
