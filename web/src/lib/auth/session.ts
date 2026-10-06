import "server-only";

import { auth, currentUser } from "@clerk/nextjs/server";
import { cache } from "react";

import { AppError, getSettings } from "@/shared";

import { connectDb } from "../db";
import { env } from "../env";
import {
  assertCanUseApp,
  findUserByClerkId,
  needsProfileSync,
  syncUserFromClerk,
  type AppUser,
  type ClerkProfile,
} from "./user-sync";

/** Reads the signed-in Clerk user (one Backend API call) into the shape we store. */
async function loadClerkProfile(): Promise<ClerkProfile | null> {
  const cu = await currentUser();
  if (!cu) return null;
  const primary = cu.primaryEmailAddress;
  if (!primary) {
    throw new AppError("VALIDATION_FAILED", { message: "Your account needs an email address to use the app." });
  }
  return {
    clerkId: cu.id,
    email: primary.emailAddress,
    emailVerified: primary.verification?.status === "verified",
    name: cu.fullName ?? cu.username ?? null,
    imageUrl: cu.imageUrl || null,
  };
}

/**
 * The signed-in user from OUR database, or null when signed out.
 *
 * Normal request: Clerk session check (no network) + one MongoDB read.
 * First sign-in, or every 15 min: also one Clerk API call + one upsert, which picks up
 * email changes and the ADMIN_EMAILS bootstrap. Deduplicated per request by `cache`.
 *
 * Does NOT check suspension or maintenance — use requireUser()/requireAdmin() for that.
 */
export const getCurrentUser = cache(async (): Promise<AppUser | null> => {
  const { userId: clerkId } = await auth();
  if (!clerkId) return null;

  await connectDb();
  const existing = await findUserByClerkId(clerkId);
  if (!needsProfileSync(existing)) return existing;

  const profile = await loadClerkProfile();
  if (!profile) return existing; // session ended between the two calls
  return syncUserFromClerk(profile, {
    adminEmails: env.ADMIN_EMAILS,
    system: await getSettings("system"),
    existing,
  });
});

/**
 * For route handlers and server actions: the signed-in user who may use the app.
 * Throws UNAUTHENTICATED, SIGNUPS_DISABLED, ACCOUNT_SUSPENDED or MAINTENANCE.
 */
export async function requireUser(): Promise<AppUser> {
  const user = await getCurrentUser();
  if (!user) throw new AppError("UNAUTHENTICATED");
  assertCanUseApp(user, await getSettings("system"));
  return user;
}

/**
 * For admin route handlers and server actions. The role is read from our database on
 * every call — this, not proxy.ts, is the security boundary (docs/ADMIN.md §1).
 */
export async function requireAdmin(): Promise<AppUser> {
  const user = await requireUser();
  if (user.role !== "admin") throw new AppError("FORBIDDEN");
  return user;
}
