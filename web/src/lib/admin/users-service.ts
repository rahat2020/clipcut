/**
 * Admin: users — list, inspect, and the actions in docs/ADMIN.md (plan, limit override,
 * reset usage, suspend, admin role, delete all data). No `server-only`, no env or Clerk
 * import: callers pass ADMIN_EMAILS and the Clerk delete function, so
 * scripts/admin-smoke-test.ts runs every rule against a real database.
 *
 * Lock-out rules: nobody changes their OWN role or status, and owners listed in
 * ADMIN_EMAILS can't be demoted, suspended or deleted from the UI.
 */
import { Types } from "mongoose";
import { z } from "zod";

import {
  AnalysisRun,
  AppError,
  AuditLog,
  Clip,
  effectivePlanLimits,
  getSettings,
  minutesUsedThisPeriod,
  quotaPeriodEnd,
  Render,
  Transcript,
  UsageEvent,
  User,
  USER_ROLES,
  USER_STATUSES,
  Video,
  writeAudit,
  type AuditActor,
  type PlanLimits,
  type UserRole,
} from "@/shared";

import { deleteUserFiles, type CloudinaryConfig } from "../uploads/cloudinary-core";
import { ADMIN_PAGE_SIZE } from "./videos-service";

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const objectId = z.string().regex(/^[a-f0-9]{24}$/, "not a valid id");

export type AdminContext = {
  actor: AuditActor & { userId: Types.ObjectId };
  /** Owners from ADMIN_EMAILS (lower-case). */
  adminEmails: readonly string[];
};

// ── list ─────────────────────────────────────────────────────

export const userListQuerySchema = z.object({
  q: z.string().trim().max(200).optional().catch(undefined),
  plan: z.string().trim().max(50).optional().catch(undefined),
  status: z.enum(USER_STATUSES).optional().catch(undefined),
  role: z.enum(USER_ROLES).optional().catch(undefined),
  sort: z.enum(["newest", "usage", "seen"]).catch("newest"),
  page: z.coerce.number().int().min(1).max(10_000).catch(1),
});
export type UserListQuery = z.infer<typeof userListQuerySchema>;

export type AdminUserRow = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  status: string;
  plan: string;
  minutesUsed: number;
  monthlyMinutes: number;
  videos: number;
  createdAt: Date;
  lastSeenAt: Date | null;
  deleted: boolean;
};

export async function listUsersForAdmin(query: UserListQuery, now = new Date()): Promise<{ rows: AdminUserRow[]; total: number }> {
  const filter: Record<string, unknown> = {};
  if (query.q) {
    const rx = new RegExp(escapeRegex(query.q), "i");
    filter.$or = [{ email: rx }, { name: rx }];
  }
  if (query.plan) filter.plan = query.plan;
  if (query.status) filter.status = query.status;
  if (query.role) filter.role = query.role;
  // "usage" sorts on the stored counter; a period that has ended still shows its old
  // number there until the next charge rolls it over (the column itself is exact).
  const sort: Record<string, 1 | -1> =
    query.sort === "usage" ? { "quota.minutesUsed": -1, createdAt: -1 } : query.sort === "seen" ? { lastSeenAt: -1 } : { createdAt: -1 };

  const [docs, total, limitsSettings] = await Promise.all([
    User.find(filter)
      .select({ email: 1, name: 1, role: 1, status: 1, plan: 1, limitsOverride: 1, quota: 1, createdAt: 1, lastSeenAt: 1, deletedAt: 1 })
      .sort(sort)
      .skip((query.page - 1) * ADMIN_PAGE_SIZE)
      .limit(ADMIN_PAGE_SIZE)
      .lean(),
    User.countDocuments(filter),
    getSettings("limits"),
  ]);
  const counts = await Video.aggregate<{ _id: Types.ObjectId; n: number }>([
    { $match: { userId: { $in: docs.map((d) => d._id) }, deletedAt: null } },
    { $group: { _id: "$userId", n: { $sum: 1 } } },
  ]);
  const videosByUser = new Map(counts.map((c) => [String(c._id), c.n]));

  return {
    total,
    rows: docs.map((u) => ({
      id: String(u._id),
      email: u.email,
      name: u.name ?? null,
      role: u.role,
      status: u.status,
      plan: u.plan,
      minutesUsed: minutesUsedThisPeriod(u, now),
      monthlyMinutes: effectivePlanLimits(u, limitsSettings).monthlyMinutes,
      videos: videosByUser.get(String(u._id)) ?? 0,
      createdAt: u.createdAt,
      lastSeenAt: u.lastSeenAt ?? null,
      deleted: !!u.deletedAt,
    })),
  };
}

// ── one user ─────────────────────────────────────────────────

export async function getUserForAdmin(userId: string, now = new Date()) {
  if (!Types.ObjectId.isValid(userId)) return null;
  const user = await User.findById(userId).lean();
  if (!user) return null;
  const limitsSettings = await getSettings("limits");
  const [videos, videoCount, usage, audit] = await Promise.all([
    Video.find({ userId: user._id })
      .select({ title: 1, status: 1, error: 1, media: 1, language: 1, "source.type": 1, createdAt: 1, deletedAt: 1 })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean(),
    Video.countDocuments({ userId: user._id, deletedAt: null }),
    UsageEvent.find({ userId: user._id }).sort({ at: -1 }).limit(20).lean(),
    AuditLog.find({ "target.type": "user", "target.id": String(user._id) }).sort({ at: -1 }).limit(20).lean(),
  ]);
  const periodStart = user.quota?.periodStart ? new Date(user.quota.periodStart) : null;
  return {
    user,
    plans: Object.keys(limitsSettings.plans),
    planLimits: limitsSettings.plans[user.plan] ?? null,
    effective: effectivePlanLimits(user, limitsSettings),
    minutesUsed: minutesUsedThisPeriod(user, now),
    periodStart,
    periodEnd: periodStart ? quotaPeriodEnd(periodStart) : null,
    videos,
    videoCount,
    usage,
    audit,
  };
}

// ── actions ──────────────────────────────────────────────────

async function loadTarget(ctx: AdminContext, userId: string, opts: { guardSelf?: boolean; guardOwner?: boolean } = {}) {
  const _id = new Types.ObjectId(objectId.parse(userId));
  const user = await User.findOne({ _id, deletedAt: null }).lean();
  if (!user) throw new AppError("NOT_FOUND", { message: "That user doesn't exist or was deleted." });
  if (opts.guardSelf && user._id.equals(ctx.actor.userId)) {
    throw new AppError("FORBIDDEN", { message: "You can't do this to your own account." });
  }
  if (opts.guardOwner && ctx.adminEmails.includes(user.email.toLowerCase())) {
    throw new AppError("FORBIDDEN", { message: "This owner is listed in ADMIN_EMAILS and can't be changed from the panel." });
  }
  return user;
}

const target = (id: Types.ObjectId) => ({ type: "user", id: String(id) });

export async function setUserPlan(ctx: AdminContext, userId: string, plan: string): Promise<void> {
  const user = await loadTarget(ctx, userId);
  const plans = (await getSettings("limits")).plans;
  if (!Object.hasOwn(plans, plan)) throw new AppError("VALIDATION_FAILED", { message: `There's no plan called "${plan}".` });
  if (user.plan === plan) return;
  await User.updateOne({ _id: user._id }, { $set: { plan } });
  await writeAudit({ actor: ctx.actor, action: "user.plan", target: target(user._id), diff: { before: { plan: user.plan }, after: { plan } } });
}

/** Blank field = use the plan's value. Same bounds as the plan settings. */
export const limitsOverrideSchema = z
  .object({
    monthlyMinutes: z.number().int().min(0).max(100_000).nullable(),
    maxFileMB: z.number().int().min(1).max(100).nullable(),
    maxDurationMin: z.number().int().min(1).max(180).nullable(),
    concurrentJobs: z.number().int().min(1).max(10).nullable(),
    maxClipsPerVideo: z.number().int().min(1).max(50).nullable(),
    clipRequestsPerVideo: z.number().int().min(0).max(50).nullable(),
    copyRequestsPerVideo: z.number().int().min(0).max(100).nullable(),
    allowYoutube: z.boolean().nullable(),
  })
  .partial();
export type LimitsOverrideInput = z.infer<typeof limitsOverrideSchema>;

export async function setUserLimitsOverride(ctx: AdminContext, userId: string, input: LimitsOverrideInput): Promise<void> {
  const parsed = limitsOverrideSchema.parse(input);
  const user = await loadTarget(ctx, userId);
  const next = Object.fromEntries(Object.entries(parsed).filter(([, v]) => v !== null && v !== undefined)) as Partial<PlanLimits>;
  const update = Object.keys(next).length ? { $set: { limitsOverride: next } } : { $unset: { limitsOverride: 1 } };
  await User.updateOne({ _id: user._id }, update);
  await writeAudit({
    actor: ctx.actor,
    action: "user.limits",
    target: target(user._id),
    diff: { before: { limitsOverride: user.limitsOverride ?? null }, after: { limitsOverride: Object.keys(next).length ? next : null } },
  });
}

/** Sets this period's used minutes back to 0; the period itself keeps its dates. */
export async function resetUserUsage(ctx: AdminContext, userId: string): Promise<void> {
  const user = await loadTarget(ctx, userId);
  await User.updateOne({ _id: user._id }, { $set: { "quota.minutesUsed": 0 } });
  await writeAudit({
    actor: ctx.actor,
    action: "user.usage.reset",
    target: target(user._id),
    diff: { before: { minutesUsed: user.quota?.minutesUsed ?? 0 }, after: { minutesUsed: 0 } },
  });
}

export const suspendSchema = z.object({ reason: z.string().trim().min(3, "give a short reason").max(500) });

export async function suspendUser(ctx: AdminContext, userId: string, input: { reason: string }): Promise<void> {
  const { reason } = suspendSchema.parse(input);
  const user = await loadTarget(ctx, userId, { guardSelf: true, guardOwner: true });
  if (user.status === "suspended") throw new AppError("CONFLICT", { message: "This account is already suspended." });
  await User.updateOne(
    { _id: user._id },
    { $set: { status: "suspended", suspension: { reason, at: new Date(), byUserId: ctx.actor.userId } } },
  );
  await writeAudit({ actor: ctx.actor, action: "user.suspend", target: target(user._id), diff: { before: { status: user.status }, after: { status: "suspended", reason } } });
}

export async function unsuspendUser(ctx: AdminContext, userId: string): Promise<void> {
  const user = await loadTarget(ctx, userId, { guardSelf: true });
  if (user.status !== "suspended") throw new AppError("CONFLICT", { message: "This account isn't suspended." });
  await User.updateOne({ _id: user._id }, { $set: { status: "active" }, $unset: { suspension: 1 } });
  await writeAudit({
    actor: ctx.actor,
    action: "user.unsuspend",
    target: target(user._id),
    diff: { before: { status: "suspended", reason: user.suspension?.reason ?? null }, after: { status: "active" } },
  });
}

export async function setUserRole(ctx: AdminContext, userId: string, role: UserRole): Promise<void> {
  const next = z.enum(USER_ROLES).parse(role);
  const user = await loadTarget(ctx, userId, { guardSelf: true, guardOwner: next !== "admin" });
  if (user.role === next) return;
  await User.updateOne({ _id: user._id }, { $set: { role: next } });
  await writeAudit({
    actor: ctx.actor,
    action: next === "admin" ? "user.admin.grant" : "user.admin.revoke",
    target: target(user._id),
    diff: { before: { role: user.role }, after: { role: next } },
  });
}

export type DeleteUserResult = { videos: number; filesDeleted: boolean; clerkDeleted: boolean };

/**
 * Deletes everything the user made: every file in Cloudinary (by folder), their videos,
 * transcripts, clip runs, clips and renders. The account is blocked at once (suspended +
 * deletedAt) and anonymised, and the Clerk account is deleted so they can't sign in.
 * Kept: usage_events (billing ledger, no content) and the audit log.
 * `confirmEmail` must match — the typed confirmation from docs/ADMIN.md §1.
 * If the files can't be removed, videos stay soft-deleted so the cleanup job can retry.
 */
export async function deleteUserData(
  ctx: AdminContext & { cfg: CloudinaryConfig; deleteClerkUser: (clerkId: string) => Promise<void> },
  userId: string,
  confirmEmail: string,
): Promise<DeleteUserResult> {
  const user = await loadTarget(ctx, userId, { guardSelf: true, guardOwner: true });
  if (confirmEmail.trim().toLowerCase() !== user.email.toLowerCase()) {
    throw new AppError("VALIDATION_FAILED", { message: "Type the user's email exactly to confirm." });
  }
  const now = new Date();

  // 1. Block first, so nothing new starts while we delete.
  await User.updateOne(
    { _id: user._id },
    { $set: { status: "suspended", deletedAt: now, suspension: { reason: "Account deleted by an admin", at: now, byUserId: ctx.actor.userId } } },
  );
  // 2. Stop and hide every video (a running job stops on its next guarded write).
  await Video.updateMany({ userId: user._id, status: { $in: ["queued", "processing"] } }, { $set: { status: "canceled" } });
  await Video.updateMany({ userId: user._id, deletedAt: null }, { $set: { deletedAt: now } });
  const videos = await Video.countDocuments({ userId: user._id });

  // 3. Files, then the records that point at them.
  const filesDeleted = await deleteUserFiles(ctx.cfg, String(user._id));
  await Promise.all([
    Clip.deleteMany({ userId: user._id }),
    Render.deleteMany({ userId: user._id }),
    AnalysisRun.deleteMany({ userId: user._id }),
    Transcript.deleteMany({ userId: user._id }),
  ]);
  if (filesDeleted) await Video.deleteMany({ userId: user._id });
  else await Video.updateMany({ userId: user._id }, { $unset: { "retention.assetsDeletedAt": 1 } });

  // 4. Anonymise what stays (the document keeps the Clerk id blocked if Clerk deletion fails).
  await User.updateOne(
    { _id: user._id },
    { $set: { email: `deleted-${String(user._id)}@deleted.invalid` }, $unset: { name: 1, imageUrl: 1, limitsOverride: 1 } },
  );
  let clerkDeleted = false;
  try {
    await ctx.deleteClerkUser(user.clerkId);
    clerkDeleted = true;
  } catch {
    clerkDeleted = false;
  }

  const result = { videos, filesDeleted, clerkDeleted };
  await writeAudit({
    actor: ctx.actor,
    action: "user.delete_data",
    target: target(user._id),
    diff: { before: { email: user.email, plan: user.plan }, after: result },
  });
  return result;
}
