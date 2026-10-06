// GENERATED — do not edit. Source: shared/src/settings/service.ts
// Edit the source, then run: node scripts/sync-shared.mjs

import { writeAudit, type AuditActor } from "../audit";
import type { SettingsGroup } from "../enums";
import { AppError, isDuplicateKeyError } from "../errors";
import { Setting } from "../models/setting";
import { defaultSettings, SETTINGS_SCHEMA_VERSION, SETTINGS_SCHEMAS, type SettingsOf } from "./schemas";

/**
 * Read and write admin-tunable settings. Always go through these functions — never
 * query the `settings` collection directly.
 *
 * Reads are cached in memory for 60 s: an admin change reaches every web instance and
 * the worker within a minute, and settings cost almost nothing against Atlas's
 * 100 ops/sec. The worker reads settings once at the start of a job, so a running job
 * never switches models halfway.
 */
export const SETTINGS_CACHE_TTL_MS = 60_000;

export type SettingsSnapshot<G extends SettingsGroup> = {
  value: SettingsOf<G>;
  /** 0 = never saved (all defaults). Pass it back as `expectedVersion` when saving. */
  version: number;
  /** Stored data didn't match the current schema; defaults are being used instead. */
  invalid: boolean;
  updatedAt: Date | null;
  updatedByEmail: string | null;
};

const cache = new Map<SettingsGroup, { snapshot: SettingsSnapshot<SettingsGroup>; expiresAt: number }>();

function parseStored<G extends SettingsGroup>(group: G, data: unknown): { value: SettingsOf<G>; invalid: boolean } {
  const result = SETTINGS_SCHEMAS[group].safeParse(data ?? {});
  if (result.success) return { value: result.data as SettingsOf<G>, invalid: false };
  // Don't crash the app over bad settings; run on defaults and let the admin panel warn.
  return { value: defaultSettings(group), invalid: true };
}

/** Full snapshot including version — what the admin panel edits. */
export async function getSettingsSnapshot<G extends SettingsGroup>(
  group: G,
  options: { fresh?: boolean } = {},
): Promise<SettingsSnapshot<G>> {
  const hit = cache.get(group);
  if (!options.fresh && hit && hit.expiresAt > Date.now()) return hit.snapshot as SettingsSnapshot<G>;

  const doc = await Setting.findById(group).lean();
  const { value, invalid } = parseStored(group, doc?.data);
  const snapshot: SettingsSnapshot<G> = {
    value,
    version: doc?.version ?? 0,
    invalid,
    updatedAt: doc?.updatedAt ?? null,
    updatedByEmail: doc?.updatedByEmail ?? null,
  };
  cache.set(group, { snapshot: snapshot as SettingsSnapshot<SettingsGroup>, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS });
  return snapshot;
}

/** Just the values — what application code uses. */
export async function getSettings<G extends SettingsGroup>(group: G): Promise<SettingsOf<G>> {
  return (await getSettingsSnapshot(group)).value;
}

/**
 * Saves a whole settings group. `expectedVersion` must be the version the admin loaded;
 * if someone saved in between, this throws SETTINGS_CONFLICT instead of overwriting.
 * Every successful save is written to the audit log.
 */
export async function updateSettings<G extends SettingsGroup>(
  group: G,
  next: unknown,
  options: { expectedVersion: number; actor: AuditActor },
): Promise<SettingsSnapshot<G>> {
  const parsed = SETTINGS_SCHEMAS[group].safeParse(next);
  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", {
      details: { group, issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
    });
  }

  const current = await getSettingsSnapshot(group, { fresh: true });
  if (current.version !== options.expectedVersion) {
    throw new AppError("SETTINGS_CONFLICT", { details: { group, expected: options.expectedVersion, actual: current.version } });
  }

  let value = parsed.data as SettingsOf<G>;
  if (group === "retention") {
    // TypeScript can't narrow a generic G from `group === "retention"`, hence the casts.
    value = stampRetentionChange(
      current.value as SettingsOf<"retention">,
      value as SettingsOf<"retention">,
    ) as SettingsOf<G>;
  }

  try {
    const res = await Setting.updateOne(
      { _id: group, version: options.expectedVersion },
      {
        $set: {
          data: value,
          schemaVersion: SETTINGS_SCHEMA_VERSION,
          updatedBy: options.actor.userId ?? undefined,
          updatedByEmail: options.actor.email,
        },
        $inc: { version: 1 },
      },
      // Version 0 means "never saved", so the document may not exist yet.
      { upsert: options.expectedVersion === 0 },
    );
    if (res.matchedCount === 0 && res.upsertedCount === 0) {
      throw new AppError("SETTINGS_CONFLICT", { details: { group } });
    }
  } catch (err) {
    // Two first-time saves racing: the loser's upsert hits the unique _id.
    if (isDuplicateKeyError(err)) throw new AppError("SETTINGS_CONFLICT", { details: { group }, cause: err });
    throw err;
  } finally {
    cache.delete(group);
  }

  await writeAudit({
    actor: options.actor,
    action: "settings.update",
    target: { type: "settings", id: group },
    diff: { before: current.value, after: value },
  });

  return getSettingsSnapshot(group, { fresh: true });
}

/**
 * `changedAt` is never taken from the admin's input: it's set to now when any plan's
 * retention days changed, otherwise kept. It drives the grace period in retention.ts.
 */
function stampRetentionChange(before: SettingsOf<"retention">, after: SettingsOf<"retention">): SettingsOf<"retention"> {
  const plans = new Set([...Object.keys(before.plans), ...Object.keys(after.plans)]);
  const daysChanged = [...plans].some((p) => before.plans[p]?.days !== after.plans[p]?.days);
  return { ...after, changedAt: daysChanged ? new Date() : before.changedAt };
}

/** For tests and for "reload now" in the admin panel. */
export function clearSettingsCache(): void {
  cache.clear();
}
