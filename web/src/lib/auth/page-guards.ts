import "server-only";

import { auth } from "@clerk/nextjs/server";
import { notFound, redirect } from "next/navigation";

import { isAppError, type ErrorCode } from "@/shared";

import { ROUTES } from "../routes";
import { requireAdmin, requireUser } from "./session";
import type { AppUser } from "./user-sync";

/** Codes that send a signed-in user to the /blocked page instead of an error screen. */
export const BLOCKED_CODES = ["ACCOUNT_SUSPENDED", "MAINTENANCE", "SIGNUPS_DISABLED"] as const satisfies readonly ErrorCode[];
export type BlockedCode = (typeof BLOCKED_CODES)[number];

function isBlockedCode(code: string): code is BlockedCode {
  return (BLOCKED_CODES as readonly string[]).includes(code);
}

async function guard(check: () => Promise<AppUser>): Promise<AppUser> {
  try {
    return await check();
  } catch (err) {
    if (isAppError(err)) {
      if (err.code === "UNAUTHENTICATED") {
        const { redirectToSignIn } = await auth();
        return redirectToSignIn();
      }
      if (isBlockedCode(err.code)) redirect(`${ROUTES.blocked}?code=${err.code}`);
      // Hide that /admin exists from non-admins.
      if (err.code === "FORBIDDEN") notFound();
    }
    throw err;
  }
}

/** For pages and layouts: the signed-in user, or a redirect to sign-in / the blocked page. */
export function requireUserPage(): Promise<AppUser> {
  return guard(requireUser);
}

/** For /admin pages and layouts: the admin user, or 404 for everyone else. */
export function requireAdminPage(): Promise<AppUser> {
  return guard(requireAdmin);
}
