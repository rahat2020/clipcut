import mongoose from "mongoose";

import { env } from "../config/env";
import { configureMongoose } from "../shared";
import { onShutdown } from "./shutdown";

let connecting: Promise<typeof mongoose> | null = null;
let hookRegistered = false;

/**
 * Opens the worker's single long-lived MongoDB connection (idempotent).
 *
 * Indexes: created automatically in development; in production they are created only by
 * `npm run db:indexes`, so a restart never triggers index builds on a busy cluster.
 */
export function connectDb(options: { dbName?: string; autoIndex?: boolean } = {}): Promise<typeof mongoose> {
  if (connecting) return connecting;
  configureMongoose();

  const autoIndex = options.autoIndex ?? env.NODE_ENV !== "production";
  connecting = mongoose
    .connect(env.MONGODB_URI, {
      dbName: options.dbName ?? env.MONGODB_DB,
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 15_000,
      autoIndex,
      autoCreate: autoIndex,
    })
    .catch((err: unknown) => {
      connecting = null;
      throw err;
    });

  if (!hookRegistered) {
    hookRegistered = true;
    onShutdown(disconnectDb);
  }
  return connecting;
}

export async function disconnectDb(): Promise<void> {
  connecting = null;
  await mongoose.disconnect();
}
