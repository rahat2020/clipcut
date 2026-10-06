/**
 * Read-only facts for the admin dashboard and System page: how full MongoDB is, which
 * migrations ran, Cloudinary credits. No `server-only`; callers pass the Cloudinary keys.
 * Costs are small and only paid when the page opens (docs/ADMIN.md §5).
 */
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import utc from "dayjs/plugin/utc";
import mongoose from "mongoose";

import type { LastBackup } from "@/shared";
import { migrationStatus, type MigrationStatus } from "@/shared/migrations/status";

import { MONGO_LIMIT_BYTES, type BackupHealth, type CloudinaryUsage } from "./system-types";

dayjs.extend(utc);
dayjs.extend(relativeTime);

export { MONGO_LIMIT_BYTES, type BackupHealth, type CloudinaryUsage };

export type CollectionInfo = { name: string; docs: number; bytes: number | null; indexes: number };
export type DatabaseInfo = {
  name: string;
  /** Data + indexes — what counts against the 512 MB. */
  usedBytes: number;
  collections: CollectionInfo[];
  migrations: MigrationStatus;
};

/** Sizes, collections, indexes and migration status of the connected database. */
export async function readDatabaseInfo(options: { collections?: boolean } = {}): Promise<DatabaseInfo> {
  const db = mongoose.connection.db;
  if (!db) throw new Error("not connected to MongoDB");
  const stats = (await db.command({ dbStats: 1 })) as { dataSize?: number; indexSize?: number; storageSize?: number };
  const usedBytes = Math.max(stats.dataSize ?? 0, 0) + Math.max(stats.indexSize ?? 0, 0);
  const migrations = await migrationStatus(db);
  if (!options.collections) return { name: db.databaseName, usedBytes, collections: [], migrations };

  const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !n.startsWith("system.")).sort();
  const collections = await Promise.all(
    names.map(async (name): Promise<CollectionInfo> => {
      const col = db.collection(name);
      const [docs, indexes, size] = await Promise.all([
        col.estimatedDocumentCount(),
        col.indexes().then((i) => i.length).catch(() => 0),
        // collStats may be refused on a shared tier — the row then just has no size.
        db.command({ collStats: name }).then((s) => (typeof s.size === "number" ? (s.size as number) + ((s.totalIndexSize as number | undefined) ?? 0) : null)).catch(() => null),
      ]);
      return { name, docs, bytes: size, indexes };
    }),
  );
  return { name: db.databaseName, usedBytes, collections, migrations };
}

/** A backup older than this means the worker missed its daily one (it checks every 3 h, backs up after 20 h). */
const BACKUP_STALE_MS = 30 * 3_600_000;

/** What the admin should read from the worker's last backup result (Redis `backup:last`). Pure. */
export function backupHealth(input: { reachable: boolean; last: LastBackup | null; enabled: boolean }, now: Date): BackupHealth {
  const { reachable, last, enabled } = input;
  if (!enabled) return { tone: "warn", headline: "Backups are switched off", detail: "Turn them on in System → Background jobs. Atlas’s free plan keeps no backups of its own." };
  if (!reachable) return { tone: "muted", headline: "Can’t reach Redis", detail: "The last backup result is kept there, so it’s unknown right now." };
  if (!last) return { tone: "warn", headline: "No backup yet", detail: "The worker makes the first one within 3 hours of starting. If this stays, check that the worker runs." };
  const when = dayjs.utc(last.at).format("YYYY-MM-DD HH:mm");
  if (last.error !== undefined) return { tone: "danger", headline: "Last backup FAILED", detail: `${when} UTC · ${last.error}` };
  const age = now.getTime() - new Date(last.at).getTime();
  const size = `${(last.bytes / 1024).toFixed(0)} KB · ${last.docs.toLocaleString("en-US")} documents`;
  if (age > BACKUP_STALE_MS) return { tone: "warn", headline: "Last backup is over a day old", detail: `${when} UTC · ${size} · is the worker running?` };
  return { tone: "ok", headline: `Last backup ${dayjs.utc(last.at).from(dayjs.utc(now))}`, detail: `${when} UTC · ${size}` };
}

let usageCache: { value: CloudinaryUsage; until: number } | null = null;

/** Credits used this month of the plan's limit (free: 25). Cached 10 minutes: it changes slowly. */
export async function readCloudinaryUsage(cfg: { cloudName: string; apiKey: string; apiSecret: string }): Promise<CloudinaryUsage> {
  if (usageCache && usageCache.until > Date.now()) return usageCache.value;
  let value: CloudinaryUsage;
  try {
    const res = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cfg.cloudName)}/usage`, {
      headers: { Authorization: `Basic ${Buffer.from(`${cfg.apiKey}:${cfg.apiSecret}`).toString("base64")}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { plan?: string; credits?: { usage?: number; limit?: number } };
    const used = body.credits?.usage;
    const limit = body.credits?.limit;
    value =
      typeof used === "number" && typeof limit === "number"
        ? { ok: true, used, limit, plan: body.plan ?? null }
        : { ok: false, reason: "Cloudinary didn't report credits for this plan." };
  } catch (err) {
    value = { ok: false, reason: `couldn't ask Cloudinary (${err instanceof Error ? err.message : "network"})` };
  }
  usageCache = { value, until: Date.now() + (value.ok ? 10 * 60_000 : 60_000) };
  return value;
}
