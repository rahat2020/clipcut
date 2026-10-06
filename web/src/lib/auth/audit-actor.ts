import "server-only";

import { headers } from "next/headers";

import type { AuditActor } from "@/shared";

import type { AppUser } from "./user-sync";

/**
 * Who did an admin action, for `writeAudit` / `updateSettings`. Adds the client IP and
 * browser from the request headers (Vercel sets x-forwarded-for; first entry is the client).
 */
export async function auditActorFor(user: AppUser): Promise<AuditActor> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || undefined;
  const userAgent = h.get("user-agent")?.slice(0, 300) || undefined;
  return { userId: user._id, email: user.email, ip, userAgent };
}
