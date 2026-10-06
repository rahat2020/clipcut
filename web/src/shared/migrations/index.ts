// GENERATED — do not edit. Source: shared/src/migrations/index.ts
// Edit the source, then run: node scripts/sync-shared.mjs

import { migration0001 } from "./0001-seed-settings";
import type { Migration } from "./types";

export type { Migration, MigrationContext } from "./types";

/**
 * Every migration, in the order it must run. Append only — never reorder, rename or
 * delete an entry once it has run anywhere.
 */
export const MIGRATIONS: readonly Migration[] = [migration0001];
