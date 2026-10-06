import "server-only";

import mongoose from "mongoose";

import { configureMongoose } from "@/shared";

import { env } from "./env";

/**
 * MongoDB connection for route handlers and server components.
 *
 * On Vercel every warm function instance reuses one connection, cached on `globalThis`
 * (which also survives Next.js hot reload in dev). A small pool keeps us well under
 * Atlas free tier's 500-connection limit even with many instances.
 */
type Cache = { promise: Promise<typeof mongoose> | null };
const globalCache = globalThis as typeof globalThis & { __mongooseCache?: Cache };
const cache: Cache = (globalCache.__mongooseCache ??= { promise: null });

export function connectDb(): Promise<typeof mongoose> {
  if (cache.promise) return cache.promise;
  configureMongoose();

  // Production indexes are created by `npm run db:indexes` in worker/, never on a cold start.
  const autoIndex = process.env.NODE_ENV !== "production";
  cache.promise = mongoose
    .connect(env.MONGODB_URI, {
      dbName: env.MONGODB_DB,
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 10_000,
      autoIndex,
      autoCreate: autoIndex,
    })
    .catch((err: unknown) => {
      cache.promise = null; // let the next request retry
      throw err;
    });
  return cache.promise;
}
