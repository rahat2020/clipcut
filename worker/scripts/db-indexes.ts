/**
 * Creates every index declared in the models — the production way to build indexes
 * (Mongoose autoIndex is off in production so cold starts never trigger index builds).
 *
 *   npm run db:indexes
 *
 * Only CREATES missing indexes. Indexes in the database that the schema no longer
 * declares are reported, never dropped — dropping is always a deliberate migration.
 */
import mongoose from "mongoose";

import { env } from "../src/config/env";
import { connectDb, disconnectDb } from "../src/lib/db";
import { ALL_MODELS } from "../src/shared";

async function main() {
  await connectDb({ autoIndex: false });
  console.log(`\nDatabase "${env.MONGODB_DB}" on ${mongoose.connection.host}\n`);

  let extra = 0;
  for (const Model of ALL_MODELS as readonly mongoose.Model<unknown>[]) {
    await Model.createCollection().catch((err: { codeName?: string }) => {
      if (err.codeName !== "NamespaceExists") throw err;
    });
    await Model.createIndexes();
    const names = (await Model.collection.indexes()).map((i) => i.name);
    const { toDrop } = await Model.diffIndexes();
    extra += toDrop.length;
    console.log(`✓ ${Model.collection.collectionName.padEnd(14)} ${names.join(", ")}`);
    for (const name of toDrop) console.log(`  ⚠ ${name} exists but is not in the schema (drop it with a migration if intended)`);
  }
  console.log(`\nAll indexes present${extra ? ` · ${extra} extra index(es) reported above` : ""}\n`);
}

main()
  .catch((err: unknown) => {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb().catch(() => {}));
