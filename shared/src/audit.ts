import type { Types } from "mongoose";

import { AuditLog } from "./models/audit-log";

export type AuditActor = {
  userId?: Types.ObjectId | null;
  email: string;
  ip?: string;
  userAgent?: string;
};

/**
 * Records an admin action. Call it after the action succeeds, with the before/after
 * values for anything that changed. Never pass secrets in `diff`.
 */
export async function writeAudit(entry: {
  actor: AuditActor;
  action: string;
  target: { type: string; id: string };
  diff?: { before?: unknown; after?: unknown };
}): Promise<void> {
  await AuditLog.create({
    actorUserId: entry.actor.userId ?? undefined,
    actorEmail: entry.actor.email,
    action: entry.action,
    target: entry.target,
    diff: entry.diff,
    ip: entry.actor.ip,
    userAgent: entry.actor.userAgent,
    at: new Date(),
  });
}
