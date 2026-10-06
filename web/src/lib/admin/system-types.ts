/**
 * Plain values and types the dashboard cards share with the code that reads the facts
 * (system-info.ts). No imports — safe in client components, unlike system-info (Mongoose).
 */

/** Atlas M0 (free) holds 512 MB. */
export const MONGO_LIMIT_BYTES = 512 * 1024 * 1024;

export type BackupHealth = { tone: "ok" | "warn" | "danger" | "muted"; headline: string; detail: string | null };

export type CloudinaryUsage = { ok: true; used: number; limit: number; plan: string | null } | { ok: false; reason: string };
