// GENERATED — do not edit. Source: shared/src/ownership.ts
// Edit the source, then run: node scripts/sync-shared.mjs

import type { Types } from "mongoose";

/**
 * The single place that decides which documents a user may access.
 *
 * Every user-facing query spreads this into its filter:
 *   Video.find({ ...ownedBy(user), status: "ready" })
 *
 * When workspaces/teams arrive (docs/SCHEMA.md §7) this returns { workspaceId }
 * instead, and no route handler has to change.
 */
export function ownedBy(user: { _id: Types.ObjectId }): { userId: Types.ObjectId } {
  return { userId: user._id };
}
