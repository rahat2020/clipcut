import { Redis } from "ioredis";

import { env } from "../config/env";
import { onShutdown } from "./shutdown";

/**
 * Connection options for BullMQ. We pass options, not a client: BullMQ ships its own
 * ioredis version, and handing it ours would mix two versions of the library.
 * `maxRetriesPerRequest: null` is required by BullMQ workers (blocking commands).
 */
export function bullConnection() {
  return { url: env.REDIS_URL, maxRetriesPerRequest: null };
}

let client: Redis | null = null;

/** One small shared client for our own keys (worker heartbeat). Not used for queues. */
export function redis(): Redis {
  if (client) return client;
  const c = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3, connectTimeout: 10_000, lazyConnect: false });
  c.on("error", () => {}); // reconnects on its own; callers see failed commands
  onShutdown(async () => {
    await c.quit().catch(() => c.disconnect());
  });
  client = c;
  return c;
}
