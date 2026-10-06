import "server-only";

import { Redis } from "ioredis";

import { AI_CAP_METRICS, aiCapKey, AppError, BACKUP_TIMING, WORKER_PRESENCE, type AiCapMetric, type LastBackup, type WorkerPresence } from "@/shared";

import { env } from "./env";
import { consumeRateLimit, RATE_LIMITS, waitText, type RateBucket, type RateResult } from "./rate-limit-core";

/**
 * web/ never touches the job queue (D35). It reads the worker's presence keys and the
 * daily AI counters for the admin panel, and keeps the admin actions' rate limit. One lazily created client per server instance, cached across hot
 * reloads; short timeouts so a Redis outage can't hang a page.
 */
const globalForRedis = globalThis as unknown as { __redis?: Redis };

function redis(): Redis {
  if (!globalForRedis.__redis) {
    const client = new Redis(env.REDIS_URL, {
      connectTimeout: 5_000,
      commandTimeout: 3_000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: true,
      lazyConnect: true,
    });
    client.on("error", () => {}); // surfaced per command below
    globalForRedis.__redis = client;
  }
  return globalForRedis.__redis;
}

let onlineCache: { value: boolean | null; until: number } | null = null;

/**
 * Is at least one worker alive? For the video page while a video waits in the queue.
 * Cached for 10 s per server instance so polling doesn't turn into Redis traffic.
 * Null when Redis can't be reached (don't claim the worker is down when we don't know).
 */
export async function isAnyWorkerOnline(): Promise<boolean | null> {
  const now = Date.now();
  if (onlineCache && onlineCache.until > now) return onlineCache.value;
  const status = await readWorkerStatus();
  const value = status.reachable ? status.workers.length > 0 : null;
  onlineCache = { value, until: now + 10_000 };
  return value;
}

export type WorkerStatus ={ reachable: true; workers: WorkerPresence[] } | { reachable: false };

/** Workers that sent a heartbeat in the last minute. */
export async function readWorkerStatus(): Promise<WorkerStatus> {
  try {
    const client = redis();
    const keys: string[] = [];
    let cursor = "0";
    do {
      const [next, batch] = await client.scan(cursor, "MATCH", WORKER_PRESENCE.pattern, "COUNT", 100);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== "0" && keys.length < 50);

    const values = keys.length ? await client.mget(...keys) : [];
    const workers = values
      .map((v) => {
        try {
          return v ? (JSON.parse(v) as WorkerPresence) : null;
        } catch {
          return null;
        }
      })
      .filter((w): w is WorkerPresence => w !== null)
      .sort((a, b) => a.id.localeCompare(b.id));
    return { reachable: true, workers };
  } catch (err) {
    console.error("[redis] worker status unavailable", err);
    return { reachable: false };
  }
}

/** The worker's last database backup result (D53), null when none was made yet or Redis can't be reached. */
export async function readLastBackup(): Promise<{ reachable: boolean; last: LastBackup | null }> {
  try {
    const raw = await redis().get(BACKUP_TIMING.lastKey);
    return { reachable: true, last: raw ? (JSON.parse(raw) as LastBackup) : null };
  } catch (err) {
    console.error("[redis] last backup unavailable", err);
    return { reachable: false, last: null };
  }
}

/** Today's AI usage counters (UTC day), or null when Redis can't be reached. */
export async function readAiUsageToday(now = new Date()): Promise<Record<AiCapMetric, number> | null> {
  try {
    const values = await redis().mget(...AI_CAP_METRICS.map((m) => aiCapKey(m, now)));
    return Object.fromEntries(AI_CAP_METRICS.map((m, i) => [m, Number(values[i] ?? 0) || 0])) as Record<AiCapMetric, number>;
  } catch (err) {
    console.error("[redis] AI usage unavailable", err);
    return null;
  }
}

/**
 * Fixed-window rate limit: `limit` calls per `windowSec` per key, else RATE_LIMITED (with how long to
 * wait). If Redis is down the call is allowed: availability beats a strict limit, and every route is
 * already behind sign-in.
 */
export async function assertRateLimit(key: string, limit: number, windowSec: number, what = "actions"): Promise<void> {
  let result: RateResult;
  try {
    result = await consumeRateLimit(redis(), key, { max: limit, windowSec });
  } catch (err) {
    console.error("[redis] rate limit unavailable", err);
    return;
  }
  if (!result.ok) {
    throw new AppError("RATE_LIMITED", { message: `Too many ${what}. Try again in ${waitText(result.retryAfterSec)}.`, details: { retryAfterSec: result.retryAfterSec } });
  }
}

/** The per-user API limit for one kind of call (table in lib/rate-limit-core.ts). */
export async function limitUser(user: { _id: unknown }, bucket: RateBucket): Promise<void> {
  const { max, windowSec } = RATE_LIMITS[bucket];
  await assertRateLimit(`user:${String(user._id)}:${bucket}`, max, windowSec, "requests");
}
