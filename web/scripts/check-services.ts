/**
 * Verifies every key in web/.env.local actually works.
 *
 *   npm run check
 *
 * Prints only hostnames and statuses — never secret values.
 * Exits with code 1 if anything fails.
 */
import { loadEnvConfig } from "@next/env";
import { v2 as cloudinary } from "cloudinary";
import { Redis } from "ioredis";
import mongoose from "mongoose";

import { formatEnvIssues, serverEnvSchema, type ServerEnv } from "../src/lib/env.schema";

const TIMEOUT_MS = 20_000;

type Result = { name: string; ok: boolean; detail: string };

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS),
    ),
  ]);
}

/** Some SDKs (Cloudinary) reject with plain objects like { error: { message, http_code } }. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; error?: { message?: unknown; http_code?: unknown } };
    const inner = e.error?.message ?? e.message;
    if (typeof inner === "string") return e.error?.http_code ? `${inner} (HTTP ${e.error.http_code})` : inner;
    try {
      return JSON.stringify(err);
    } catch {
      /* fall through */
    }
  }
  return String(err);
}

async function check(name: string, fn: () => Promise<string>, hint: (msg: string) => string): Promise<Result> {
  try {
    const detail = await withTimeout(fn(), name);
    return { name, ok: true, detail };
  } catch (err) {
    const msg = errorMessage(err);
    return { name, ok: false, detail: `${msg}\n      → ${hint(msg)}` };
  }
}

/** pk_test_<base64("xxx.clerk.accounts.dev$")> — the host is public, safe to print. */
function clerkInstanceHost(publishableKey: string): string {
  try {
    const encoded = publishableKey.split("_").slice(2).join("_");
    return Buffer.from(encoded, "base64").toString("utf8").replace(/\$$/, "");
  } catch {
    return "(could not decode)";
  }
}

async function checkClerk(env: ServerEnv): Promise<string> {
  const res = await fetch("https://api.clerk.com/v1/users?limit=1", {
    headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` },
  });
  if (!res.ok) throw new Error(`Clerk API answered HTTP ${res.status}`);
  const mode = env.CLERK_SECRET_KEY.startsWith("sk_live_") ? "live" : "test";
  return `secret key accepted (${mode} mode) · instance ${clerkInstanceHost(env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY)}`;
}

async function checkMongo(env: ServerEnv): Promise<string> {
  const conn = mongoose.createConnection(env.MONGODB_URI, {
    dbName: env.MONGODB_DB,
    serverSelectionTimeoutMS: 15_000,
  });
  try {
    await conn.asPromise();
    await conn.db!.admin().ping();
    return `connected to ${conn.host} · database "${env.MONGODB_DB}"`;
  } finally {
    await conn.close().catch(() => {});
  }
}

async function checkRedis(env: ServerEnv): Promise<string> {
  const redis = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 15_000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  redis.on("error", () => {}); // reported through the awaited calls below
  try {
    await redis.connect();
    const pong = await redis.ping();
    if (pong !== "PONG") throw new Error(`unexpected PING reply: ${pong}`);

    const info = await redis.info("memory");
    const policy = /maxmemory_policy:(\S+)/.exec(info)?.[1] ?? "unknown";
    const host = new URL(env.REDIS_URL).hostname;
    if (policy !== "noeviction") {
      throw new Error(`connected to ${host}, but eviction policy is "${policy}"`);
    }
    return `connected to ${host} · eviction policy noeviction`;
  } finally {
    redis.disconnect();
  }
}

async function checkCloudinary(env: ServerEnv): Promise<string> {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });
  const res = await cloudinary.api.ping();
  if (res.status !== "ok") throw new Error(`ping returned ${JSON.stringify(res)}`);
  return `cloud "${env.CLOUDINARY_CLOUD_NAME}" · uploads will go to folder "${env.CLOUDINARY_FOLDER}/"`;
}

async function main() {
  loadEnvConfig(process.cwd());

  console.log("\nChecking web/.env.local\n");

  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.log("✗ Some variables are missing or malformed:\n");
    for (const line of formatEnvIssues(parsed.error)) console.log(`  - ${line}`);
    console.log("\nFix these in web/.env.local, then run npm run check again.\n");
    process.exit(1);
  }
  const env = parsed.data;
  console.log("✓ All variables present and well-formed\n");

  const results = await Promise.all([
    check("Clerk", () => checkClerk(env), (m) =>
      m.includes("401") || m.includes("403")
        ? "CLERK_SECRET_KEY is wrong — copy it again from Clerk → API Keys"
        : "check your internet connection"),
    check("MongoDB", () => checkMongo(env), (m) =>
      /auth/i.test(m)
        ? "wrong username/password in MONGODB_URI (Atlas → Database Access)"
        : /ENOTFOUND|querySrv/i.test(m)
          ? "cluster host not found — re-copy the connection string"
          : "Atlas → Network Access → allow 0.0.0.0/0, then wait ~1 minute"),
    check("Redis", () => checkRedis(env), (m) =>
      m.includes("eviction policy")
        ? "Redis Cloud → database → Configuration → Edit → Data eviction policy = noeviction"
        : /WRONGPASS|NOAUTH|auth/i.test(m)
          ? "wrong password in REDIS_URL"
          : "re-copy REDIS_URL from Redis Cloud → Connect"),
    check("Cloudinary", () => checkCloudinary(env), (m) =>
      /401|invalid|api_key|signature/i.test(m)
        ? "CLOUDINARY_API_KEY / API_SECRET don't match this cloud name"
        : "check CLOUDINARY_CLOUD_NAME"),
  ]);

  for (const r of results) {
    console.log(`${r.ok ? "✓" : "✗"} ${r.name.padEnd(11)} ${r.detail}`);
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} services OK\n`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error("Unexpected error:", errorMessage(err));
  process.exit(1);
});
