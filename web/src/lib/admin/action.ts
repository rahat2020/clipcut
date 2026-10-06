import "server-only";

import { z } from "zod";

import { isAppError, type AuditActor } from "@/shared";

import { auditActorFor } from "../auth/audit-actor";
import { requireAdmin } from "../auth/session";
import type { AppUser } from "../auth/user-sync";
import { assertRateLimit } from "../redis";

/** What every admin server action returns: data, or a message that's safe to show. */
export type ActionResult<T = null> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

/** Admin actions per admin per minute (docs/ADMIN.md §1: admin actions are rate-limited). */
const ACTIONS_PER_MINUTE = 30;

/**
 * Runs one admin action: role check from OUR database (every time — server actions skip
 * layouts), rate limit, then `fn`. Errors become `{ ok: false }` with the AppError's safe
 * message; anything unexpected is logged and reported as INTERNAL.
 */
export async function runAdminAction<T>(
  fn: (ctx: { admin: AppUser; actor: AuditActor & { userId: AppUser["_id"] } }) => Promise<T>,
): Promise<ActionResult<T>> {
  try {
    const admin = await requireAdmin();
    await assertRateLimit(`admin:${String(admin._id)}`, ACTIONS_PER_MINUTE, 60, "admin actions");
    const actor = { ...(await auditActorFor(admin)), userId: admin._id };
    return { ok: true, data: await fn({ admin, actor }) };
  } catch (err) {
    if (isAppError(err)) return { ok: false, error: { code: err.code, message: err.message } };
    if (err instanceof z.ZodError) {
      const first = err.issues[0];
      return { ok: false, error: { code: "VALIDATION_FAILED", message: first ? `${first.path.join(".") || "input"}: ${first.message}` : "Invalid input." } };
    }
    console.error("[admin] action failed", err);
    return { ok: false, error: { code: "INTERNAL", message: "Something went wrong on our side." } };
  }
}
