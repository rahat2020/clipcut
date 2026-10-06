// GENERATED — do not edit. Source: shared/src/models/audit-log.ts
// Edit the source, then run: node scripts/sync-shared.mjs

import { Schema, type InferSchemaType } from "mongoose";

import { refField, registerModel, schemaVersionField } from "../db/fields";

export const AUDIT_LOG_SCHEMA_VERSION = 1;

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

/** Every admin action: who, what, on which record, and what changed. */
const auditLogSchema = new Schema(
  {
    schemaVersion: schemaVersionField(AUDIT_LOG_SCHEMA_VERSION),
    actorUserId: refField("User"),
    actorEmail: { type: String, required: true },
    /** Dotted verb, e.g. "settings.update", "user.suspend", "video.delete", "job.retry". */
    action: { type: String, required: true },
    target: {
      type: { type: String, required: true },
      id: { type: String, required: true },
    },
    diff: {
      before: { type: Schema.Types.Mixed },
      after: { type: Schema.Types.Mixed },
    },
    ip: { type: String },
    userAgent: { type: String },
    at: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: false },
);

// TTL is safe here: audit logs have no external files to clean up first.
auditLogSchema.index({ at: 1 }, { expireAfterSeconds: ONE_YEAR_SECONDS });
auditLogSchema.index({ "target.type": 1, "target.id": 1 });
auditLogSchema.index({ actorUserId: 1, at: -1 });

export type AuditLogDoc = InferSchemaType<typeof auditLogSchema>;
export const AuditLog = registerModel("AuditLog", auditLogSchema, "audit_logs");
