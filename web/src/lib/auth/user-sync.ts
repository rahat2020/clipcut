/**
 * Keeps our `users` collection in step with Clerk and decides who may use the app.
 *
 * No `server-only` import and no Clerk import, so scripts/auth-smoke-test.ts can run
 * every rule here against a real database. `session.ts` feeds it the signed-in user.
 */
import type { Types } from "mongoose";

import {
  AppError,
  isDuplicateKeyError,
  User,
  writeAudit,
  type SettingsOf,
  type UserDoc,
} from "@/shared";

/** The parts of a Clerk user we copy into our database. */
export type ClerkProfile = {
  clerkId: string;
  /** Primary email address, as Clerk has it. */
  email: string;
  emailVerified: boolean;
  name: string | null;
  imageUrl: string | null;
};

export type AppUser = UserDoc & { _id: Types.ObjectId };

/** How often a signed-in user's profile is re-read from Clerk (and `lastSeenAt` written). */
export const PROFILE_SYNC_INTERVAL_MS = 15 * 60_000;

/** Profile is refreshed from Clerk when our copy is missing or older than the interval. */
export function needsProfileSync(user: AppUser | null, now = new Date()): boolean {
  if (!user) return true;
  const last = user.lastSeenAt?.getTime() ?? 0;
  return now.getTime() - last >= PROFILE_SYNC_INTERVAL_MS;
}

/** Owner bootstrap: only a *verified* primary email on the ADMIN_EMAILS list counts. */
export function isBootstrapAdmin(profile: ClerkProfile, adminEmails: readonly string[]): boolean {
  return profile.emailVerified && adminEmails.includes(profile.email.trim().toLowerCase());
}

export function findUserByClerkId(clerkId: string): Promise<AppUser | null> {
  return User.findOne({ clerkId }).lean<AppUser>();
}

/**
 * Creates the user on first sign-in, otherwise refreshes email/name/avatar/lastSeenAt.
 * Promotes to admin when the email is on ADMIN_EMAILS (never demotes — admins granted
 * from the panel keep their role). One upsert, so two first requests racing each other
 * still produce one document.
 *
 * Throws SIGNUPS_DISABLED for a brand-new, non-owner user while sign-ups are off.
 */
export async function syncUserFromClerk(
  profile: ClerkProfile,
  opts: { adminEmails: readonly string[]; system: SettingsOf<"system">; existing: AppUser | null; now?: Date },
): Promise<AppUser> {
  const now = opts.now ?? new Date();
  const makeAdmin = isBootstrapAdmin(profile, opts.adminEmails);

  if (!opts.existing && !opts.system.signupsEnabled && !makeAdmin) {
    throw new AppError("SIGNUPS_DISABLED");
  }

  const set: Record<string, unknown> = {
    email: profile.email,
    lastSeenAt: now,
  };
  if (profile.name) set.name = profile.name;
  if (profile.imageUrl) set.imageUrl = profile.imageUrl;
  if (makeAdmin) set.role = "admin";

  const upsert = () =>
    User.findOneAndUpdate(
      { clerkId: profile.clerkId },
      { $set: set, $setOnInsert: { clerkId: profile.clerkId } },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    ).lean<AppUser>();

  let user: AppUser | null;
  try {
    user = await upsert();
  } catch (err) {
    // A concurrent first request inserted it between our find and upsert: now it's an update.
    if (!isDuplicateKeyError(err)) throw err;
    user = await upsert();
  }
  if (!user) throw new AppError("INTERNAL", { message: "User upsert returned nothing" });

  const previousRole = opts.existing?.role ?? null;
  if (makeAdmin && previousRole !== "admin") {
    await writeAudit({
      actor: { userId: user._id, email: user.email },
      action: "user.admin.bootstrap",
      target: { type: "user", id: String(user._id) },
      diff: { before: { role: previousRole }, after: { role: "admin" } },
    });
  }
  return user;
}

/**
 * Whether this account may use the app right now. Admins always pass maintenance mode
 * so the owner can fix things while users see the maintenance page.
 */
export function assertCanUseApp(user: AppUser, system: SettingsOf<"system">): void {
  if (user.status === "suspended") {
    throw new AppError("ACCOUNT_SUSPENDED", { details: { reason: user.suspension?.reason } });
  }
  if (system.maintenanceMode && user.role !== "admin") {
    throw new AppError("MAINTENANCE");
  }
}
