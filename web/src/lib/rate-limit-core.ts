/**
 * Per-user request limits for the API (Step 17). One table says how many calls of each kind a
 * user may make in a window; routes name a bucket, they never invent numbers. No `server-only`
 * and no env import: review:smoke runs it with a fake Redis client.
 *
 * Fixed windows: `max` calls per `windowSec`; the first call of a window sets its expiry.
 * The numbers are far above what the app itself does (the video page polls every 2–5 s per tab)
 * and low enough to stop a script from hammering paid work (uploads, renders, AI requests).
 */
export const RATE_LIMITS = {
  /** Polling and page data: GET /api/videos/:id every 2–5 s per open tab, /api/me, renders list. */
  read: { max: 300, windowSec: 60 },
  /** Verdicts, trims, framing, deleting. */
  write: { max: 90, windowSec: 60 },
  /** Upload tickets, finishing an upload, submitting a YouTube link. */
  upload: { max: 30, windowSec: 3_600 },
  /** Pressing Retry on a failed video. */
  retry: { max: 10, windowSec: 600 },
  /** Render a clip (ffmpeg time on the worker). */
  render: { max: 40, windowSec: 600 },
  /** Find new clips, write post text again, Banglish switch (each is also capped per video by the plan). */
  ai: { max: 20, windowSec: 600 },
  /** Signed download links. */
  download: { max: 120, windowSec: 600 },
} as const;

export type RateBucket = keyof typeof RATE_LIMITS;

/** The two Redis commands the limiter needs (ioredis has both). */
export type CounterClient = { incr(key: string): Promise<number>; expire(key: string, seconds: number): Promise<unknown> };

export type RateResult = { ok: true } | { ok: false; retryAfterSec: number };

/** Counts one call in the current window; `ok: false` says how many seconds until the window ends. */
export async function consumeRateLimit(
  client: CounterClient,
  key: string,
  limit: { max: number; windowSec: number },
  nowMs = Date.now(),
): Promise<RateResult> {
  const nowSec = Math.floor(nowMs / 1000);
  const window = Math.floor(nowSec / limit.windowSec);
  const fullKey = `ratelimit:${key}:${window}`;
  const count = await client.incr(fullKey);
  if (count === 1) await client.expire(fullKey, limit.windowSec + 5);
  if (count <= limit.max) return { ok: true };
  return { ok: false, retryAfterSec: Math.max(1, (window + 1) * limit.windowSec - nowSec) };
}

/** "37 seconds" / "4 minutes" for the error message. */
export function waitText(sec: number): string {
  return sec < 90 ? `${sec} second${sec === 1 ? "" : "s"}` : `${Math.ceil(sec / 60)} minutes`;
}
