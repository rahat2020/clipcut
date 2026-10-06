/**
 * When a used-up AI quota comes back (Step 17). Gemini's free-tier daily quotas reset at
 * midnight Pacific time; our own daily caps (settings.ai.dailyCaps) at midnight UTC.
 * Pure functions of a date, so they are tested without a clock.
 */

const PACIFIC = "America/Los_Angeles";
/** Land a little after the reset, not on it. */
const MARGIN_MS = 2 * 60_000;

/** How far the zone is ahead of UTC at this instant (negative for Pacific). */
function offsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const local = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return local - Math.floor(at.getTime() / 1000) * 1000;
}

export function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) + MARGIN_MS);
}

export function nextPacificMidnight(now: Date): Date {
  const offset = offsetMs(now, PACIFIC);
  const local = new Date(now.getTime() + offset); // the Pacific wall clock, read as if it were UTC
  const nextLocalMidnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1);
  // The offset can change at 2 a.m. (daylight saving); midnight itself is never skipped.
  const guess = new Date(nextLocalMidnight - offset);
  return new Date(nextLocalMidnight - offsetMs(guess, PACIFIC) + MARGIN_MS);
}

/**
 * The earliest time a limit we know of comes back: the video then tries again, and if that
 * limit wasn't the only one it waits again (a few times at most).
 */
export function quotaResumeAt(now: Date, args: { gemini: boolean; ours: boolean }): Date {
  const times: Date[] = [];
  if (args.gemini) times.push(nextPacificMidnight(now));
  if (args.ours || times.length === 0) times.push(nextUtcMidnight(now));
  return new Date(Math.min(...times.map((d) => d.getTime())));
}
