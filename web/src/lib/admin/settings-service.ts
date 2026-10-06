/**
 * Admin: limits & plans, retention, system switches, and per-video expiry (docs/ADMIN.md).
 * No `server-only` and no env import, so scripts/admin-smoke-test.ts runs the rules for real.
 *
 * Every save sends the WHOLE group with the version it was loaded at (stale → SETTINGS_CONFLICT),
 * is validated by the shared zod schema, and is audited by `updateSettings`.
 */
import { Types } from "mongoose";
import { z } from "zod";

import {
  AppError,
  DEFAULT_PLAN,
  effectiveExpiry,
  expiryCandidatesFilter,
  getSettings,
  getSettingsSnapshot,
  isExpired,
  limitsSettingsSchema,
  retentionSettingsSchema,
  stampRetentionChange,
  updateSettings,
  User,
  Video,
  writeAudit,
  type AuditActor,
  type RetentionSettings,
  type SettingsSnapshot,
} from "@/shared";

import { requiredRetentionConfirmation, retentionImpact, type ImpactVideo, type RetentionImpact } from "./retention-impact";

const DAY_MS = 24 * 60 * 60 * 1000;
const version = (v: number) => z.number().int().min(0).parse(v);

// ── limits & plans ───────────────────────────────────────────

/** Letters, digits, - and _ — a plan name is stored on users and shown in filters. */
const PLAN_NAME = /^[a-z][a-z0-9_-]{1,29}$/;

/**
 * Saves the `limits` group. A plan can't be removed while users are on it (they'd silently
 * fall back to "free"), and new plan names must be simple lower-case words.
 */
export async function saveLimits(actor: AuditActor, value: unknown, expectedVersion: number): Promise<SettingsSnapshot<"limits">> {
  const parsed = limitsSettingsSchema.safeParse(value);
  if (parsed.success) {
    const before = (await getSettings("limits")).plans;
    const next = parsed.data.plans;
    const added = Object.keys(next).filter((p) => !(p in before));
    const bad = added.find((p) => !PLAN_NAME.test(p));
    if (bad) throw new AppError("VALIDATION_FAILED", { message: `"${bad}" isn't a valid plan name. Use lower-case letters, digits, - or _ (2–30 characters).` });
    const removed = Object.keys(before).filter((p) => !(p in next));
    if (removed.length > 0) {
      const inUse = await User.countDocuments({ plan: { $in: removed } });
      if (inUse > 0) {
        throw new AppError("VALIDATION_FAILED", { message: `${inUse} user${inUse === 1 ? " is" : "s are"} still on ${removed.map((p) => `"${p}"`).join(", ")}. Move them to another plan first.` });
      }
    }
  }
  return updateSettings("limits", value, { expectedVersion: version(expectedVersion), actor });
}

/** How many users are on each plan — shown beside the plan and used to block removing one. */
export async function usersPerPlan(): Promise<Record<string, number>> {
  const rows = await User.aggregate<{ _id: string; n: number }>([{ $group: { _id: "$plan", n: { $sum: 1 } } }]);
  return Object.fromEntries(rows.map((r) => [r._id, r.n]));
}

// ── system ───────────────────────────────────────────────────

export async function saveSystem(actor: AuditActor, value: unknown, expectedVersion: number): Promise<SettingsSnapshot<"system">> {
  return updateSettings("system", value, { expectedVersion: version(expectedVersion), actor });
}

// ── retention ────────────────────────────────────────────────

export type RetentionPreview = {
  impact: RetentionImpact;
  /** Soft-deleted video documents the new "purge after" would remove at once. */
  purgeDue: number;
  /** What must be typed to confirm, or null when nothing is deleted sooner. */
  confirm: string | null;
  /** When the new rule starts deleting: no sooner than this (the grace period). */
  graceUntil: Date | null;
  settings: RetentionSettings;
};

/** Videos that still have files and follow their owner's plan (a per-video override isn't touched by plan changes). */
async function impactVideos(): Promise<ImpactVideo[]> {
  const rows = await Video.aggregate<{ userId: Types.ObjectId; finishedAt: Date }>([
    { $match: { "retention.finishedAt": { $ne: null }, "retention.assetsDeletedAt": null, "retention.expireOverrideAt": null, deletedAt: null } },
    { $project: { userId: 1, finishedAt: "$retention.finishedAt" } },
    { $limit: 50_000 },
  ]);
  const ownerIds = [...new Set(rows.map((r) => String(r.userId)))];
  const owners = await User.find({ _id: { $in: ownerIds } }).select({ plan: 1 }).lean();
  const plans = new Map(owners.map((u) => [String(u._id), u.plan]));
  return rows.map((r) => ({ userId: String(r.userId), plan: plans.get(String(r.userId)) ?? DEFAULT_PLAN, finishedAt: r.finishedAt }));
}

/** What saving this retention value would do — computed on the real videos, saves nothing. */
export async function previewRetention(value: unknown, now = new Date()): Promise<RetentionPreview> {
  const parsed = retentionSettingsSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", { message: parsed.error.issues[0] ? `${parsed.error.issues[0].path.join(".") || "retention"}: ${parsed.error.issues[0].message}` : "Invalid retention settings." });
  }
  const before = (await getSettingsSnapshot("retention", { fresh: true })).value;
  // The same stamping the save does (changedAt = now when some plan's days changed), on this call's clock.
  const daysChanged = stampRetentionChange(before, parsed.data).changedAt !== before.changedAt;
  const stamped: RetentionSettings = { ...parsed.data, changedAt: daysChanged ? now : before.changedAt };

  const impact = retentionImpact(await impactVideos(), before, stamped, now);

  let purgeDue = 0;
  if (stamped.purgeSoftDeletedAfterDays < before.purgeSoftDeletedAfterDays) {
    const [dueNew, dueOld] = await Promise.all([
      Video.countDocuments({ deletedAt: { $lt: new Date(now.getTime() - stamped.purgeSoftDeletedAfterDays * DAY_MS) } }),
      Video.countDocuments({ deletedAt: { $lt: new Date(now.getTime() - before.purgeSoftDeletedAfterDays * DAY_MS) } }),
    ]);
    purgeDue = Math.max(0, dueNew - dueOld);
  }

  return {
    impact,
    purgeDue,
    confirm: requiredRetentionConfirmation(before, stamped, impact, purgeDue),
    graceUntil: daysChanged && stamped.graceHours > 0 ? new Date(now.getTime() + stamped.graceHours * 3_600_000) : null,
    settings: stamped,
  };
}

/**
 * Saves the `retention` group. A change that deletes files sooner needs the new value typed
 * (checked here, not only in the browser).
 */
export async function saveRetention(actor: AuditActor, value: unknown, expectedVersion: number, confirm: string, now = new Date()): Promise<SettingsSnapshot<"retention">> {
  const preview = await previewRetention(value, now);
  if (preview.confirm !== null && confirm.trim() !== preview.confirm) {
    throw new AppError("VALIDATION_FAILED", { message: `This deletes files sooner. Type ${preview.confirm} to confirm.` });
  }
  return updateSettings("retention", value, { expectedVersion: version(expectedVersion), actor });
}

export type ExpiringVideo = { id: string; title: string; language: string; owner: string; expiresAt: Date; overridden: boolean };

/**
 * Videos whose files are deleted within `hours` (or are already past due and waiting for the next
 * cleanup run), soonest first. `total` counts all of them; `rows` is at most `limit`.
 */
export async function expiringSoon(hours: number, limit: number, now = new Date()): Promise<{ total: number; rows: ExpiringVideo[] }> {
  const settings = await getSettings("retention");
  const horizon = new Date(now.getTime() + hours * 3_600_000);
  const candidates = await Video.find({ ...expiryCandidatesFilter(settings, horizon), deletedAt: null })
    .select({ title: 1, language: 1, userId: 1, retention: 1 })
    .sort({ "retention.finishedAt": 1 })
    .limit(500)
    .lean();
  const owners = await User.find({ _id: { $in: [...new Set(candidates.map((v) => String(v.userId)))] } }).select({ email: 1, plan: 1 }).lean();
  const byId = new Map(owners.map((u) => [String(u._id), u]));

  const due = candidates
    .map((v) => {
      const owner = byId.get(String(v.userId));
      const plan = owner?.plan ?? DEFAULT_PLAN;
      return { v, owner, plan, expiresAt: effectiveExpiry(v, plan, settings) };
    })
    .filter((x) => x.expiresAt && isExpired(x.v, x.plan, settings, horizon))
    .sort((a, b) => a.expiresAt!.getTime() - b.expiresAt!.getTime());

  return {
    total: due.length,
    rows: due.slice(0, limit).map((x) => ({
      id: String(x.v._id),
      title: x.v.title,
      language: x.v.language,
      owner: x.owner?.email ?? "?",
      expiresAt: x.expiresAt!,
      overridden: !!x.v.retention?.expireOverrideAt,
    })),
  };
}

/**
 * Per-video expiry: keep this video's files for `days` more days from now, or `null` to go back to
 * the plan's rule. Only while the files still exist — deleted files can't come back.
 */
export async function adminSetVideoExpiry(actor: AuditActor, videoId: string, days: number | null, now = new Date()): Promise<void> {
  const id = z.string().regex(/^[a-f0-9]{24}$/, "not a valid id").parse(videoId);
  const keepDays = days === null ? null : z.number().int().min(1).max(365).parse(days);

  const video = await Video.findOne({ _id: id }).select({ retention: 1, deletedAt: 1, status: 1 }).lean();
  if (!video) throw new AppError("NOT_FOUND");
  if (video.deletedAt || video.retention?.assetsDeletedAt) {
    throw new AppError("VALIDATION_FAILED", { message: "This video's files are already deleted — they can't be kept longer." });
  }

  const before = video.retention?.expireOverrideAt ?? null;
  const after = keepDays === null ? null : new Date(now.getTime() + keepDays * DAY_MS);
  await Video.updateOne({ _id: id, "retention.assetsDeletedAt": null }, after ? { $set: { "retention.expireOverrideAt": after } } : { $unset: { "retention.expireOverrideAt": 1 } });
  await writeAudit({ actor, action: "video.expiry", target: { type: "video", id }, diff: { before: { expireOverrideAt: before }, after: { expireOverrideAt: after } } });
}
