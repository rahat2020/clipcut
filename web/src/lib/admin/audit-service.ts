/**
 * Admin: the audit log viewer — every admin action, filterable by who, what and which record
 * (docs/ADMIN.md). No `server-only`; read-only.
 */
import { z } from "zod";

import { AuditLog } from "@/shared";

import { ADMIN_PAGE_SIZE } from "./videos-service";

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const auditListQuerySchema = z.object({
  /** Part of the admin's email. */
  who: z.string().trim().max(200).optional().catch(undefined),
  /** Exact action ("video.delete") or a group ("video."). */
  action: z.string().trim().max(80).optional().catch(undefined),
  /** Kind of record: settings, user, video… */
  target: z.string().trim().max(40).optional().catch(undefined),
  /** One record's id — set by the links on user and video pages. */
  id: z.string().trim().max(60).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(10_000).catch(1),
});
export type AuditListQuery = z.infer<typeof auditListQuerySchema>;

export type AuditRow = {
  id: string;
  at: Date;
  who: string;
  action: string;
  target: { type: string; id: string };
  /** The change as pretty JSON, cut at 6000 characters; null when the action recorded none. */
  diff: string | null;
  ip: string | null;
};

const DIFF_LIMIT = 6000;

function diffText(diff: { before?: unknown; after?: unknown } | null | undefined): string | null {
  if (!diff || (diff.before === undefined && diff.after === undefined)) return null;
  const text = JSON.stringify({ before: diff.before, after: diff.after }, null, 2);
  return text.length > DIFF_LIMIT ? `${text.slice(0, DIFF_LIMIT)}\n… (cut)` : text;
}

export async function listAudit(query: AuditListQuery): Promise<{ rows: AuditRow[]; total: number; actions: string[]; targets: string[] }> {
  const filter: Record<string, unknown> = {};
  if (query.who) filter.actorEmail = { $regex: escapeRegex(query.who.toLowerCase()), $options: "i" };
  if (query.action) filter.action = query.action.endsWith(".") ? { $regex: `^${escapeRegex(query.action)}` } : query.action;
  if (query.target) filter["target.type"] = query.target;
  if (query.id) filter["target.id"] = query.id;

  const [docs, total, actions, targets] = await Promise.all([
    AuditLog.find(filter)
      .sort({ at: -1 })
      .skip((query.page - 1) * ADMIN_PAGE_SIZE)
      .limit(ADMIN_PAGE_SIZE)
      .lean(),
    AuditLog.countDocuments(filter),
    AuditLog.distinct("action"),
    AuditLog.distinct("target.type"),
  ]);
  return {
    rows: docs.map((a) => ({
      id: String(a._id),
      at: a.at,
      who: a.actorEmail,
      action: a.action,
      target: { type: a.target?.type ?? "?", id: a.target?.id ?? "?" },
      diff: diffText(a.diff),
      ip: a.ip ?? null,
    })),
    total,
    actions: (actions as string[]).sort(),
    targets: (targets as string[]).sort(),
  };
}
