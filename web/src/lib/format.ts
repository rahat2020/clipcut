import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import utc from "dayjs/plugin/utc";

dayjs.extend(utc);
dayjs.extend(relativeTime);

/** Admin-facing timestamp. Always UTC so server-rendered and client-rendered values match. */
export function formatUtc(date: Date | string | null | undefined): string {
  return date ? `${dayjs.utc(date).format("YYYY-MM-DD HH:mm")} UTC` : "—";
}

/**
 * A day for users: "Oct 29". Formatted in UTC on the server so the page and hydration
 * agree; near midnight it can be a day off in the viewer's timezone, fine for a reset date.
 */
export function formatDay(date: Date | string): string {
  return dayjs.utc(date).format("MMM D");
}

/** Media length as a timecode: 48:12, or 1:02:03 for an hour or more. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** File size in B, KB, MB or GB (1 KB = 1024 B), one decimal from MB up. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** Transfer speed: "450 KB/s", "2.4 MB/s". */
export function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(Math.round(bytesPerSec))}/s`;
}

/** Time left, rounded the way people say it: "less than a minute", "about 3 min", "about 1 h 20 min". */
export function formatTimeLeft(seconds: number): string {
  if (seconds < 45) return "less than a minute";
  const min = Math.round(seconds / 60);
  if (min < 60) return `about ${Math.max(min, 1)} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `about ${h} h${m ? ` ${m} min` : ""}`;
}

/** "in 6 days", "in 3 hours" — for expiry notes. */
export function fromNow(date: Date | string): string {
  return dayjs(date).fromNow();
}
