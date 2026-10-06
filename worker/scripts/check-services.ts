/**
 * Verifies every key and tool the worker needs.
 *
 *   npm run check
 *
 * Prints only hostnames, versions and statuses — never secret values.
 * Exits with code 1 if anything fails.
 */
import { execFile as execFileCb } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { v2 as cloudinary } from "cloudinary";
import { Redis } from "ioredis";
import mongoose from "mongoose";

import { formatEnvIssues, loadEnvFile, workerEnvSchema, type WorkerEnv } from "../src/config/env.schema";

const execFile = promisify(execFileCb);
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

// ── Cloud services ──────────────────────────────────────────

async function checkMongo(env: WorkerEnv): Promise<string> {
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

async function checkRedis(env: WorkerEnv): Promise<string> {
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

async function checkCloudinary(env: WorkerEnv): Promise<string> {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });
  const res = await cloudinary.api.ping();
  if (res.status !== "ok") throw new Error(`ping returned ${JSON.stringify(res)}`);
  return `cloud "${env.CLOUDINARY_CLOUD_NAME}" · folder "${env.CLOUDINARY_FOLDER}/"`;
}

async function checkGroq(env: WorkerEnv): Promise<string> {
  const res = await fetch("https://api.groq.com/openai/v1/models", {
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
  });
  if (!res.ok) throw new Error(`Groq API answered HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { id: string }[] };
  const ids = (body.data ?? []).map((m) => m.id);
  const whisper = ids.filter((id) => id.includes("whisper"));
  if (!ids.includes("whisper-large-v3")) {
    throw new Error(`key works, but whisper-large-v3 is not listed (whisper models: ${whisper.join(", ") || "none"})`);
  }
  return `key accepted · whisper models: ${whisper.join(", ")}`;
}

async function checkGemini(env: WorkerEnv): Promise<string> {
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", {
    headers: { "x-goog-api-key": env.GEMINI_API_KEY },
  });
  if (!res.ok) throw new Error(`Gemini API answered HTTP ${res.status}`);
  const body = (await res.json()) as { models?: { name: string }[] };
  const flash = (body.models ?? [])
    .map((m) => m.name.replace(/^models\//, ""))
    .filter((n) => /^gemini-[\d.]+-flash$/.test(n))
    .sort()
    .reverse();
  if (flash.length === 0) throw new Error("key works, but no Gemini Flash models are listed");
  const planned = flash.includes("gemini-2.5-flash") ? "gemini-2.5-flash available" : "gemini-2.5-flash NOT listed";
  return `key accepted · ${planned} · flash models: ${flash.slice(0, 4).join(", ")}`;
}

// ── Local tools ─────────────────────────────────────────────

/** Local checks need no secrets, so they run even when keys are missing. */
const localEnvSchema = workerEnvSchema.pick({
  SCRATCH_DIR: true,
  FFMPEG_PATH: true,
  FFPROBE_PATH: true,
  YTDLP_PATH: true,
});
type LocalEnv = Pick<WorkerEnv, "SCRATCH_DIR" | "FFMPEG_PATH" | "FFPROBE_PATH" | "YTDLP_PATH">;

async function checkFfmpeg(env: LocalEnv): Promise<string> {
  const { stdout } = await execFile(env.FFMPEG_PATH, ["-hide_banner", "-version"]);
  const version = /ffmpeg version (\S+)/.exec(stdout)?.[1] ?? "unknown";
  const missing = ["libass", "libharfbuzz", "libfreetype", "libx264"].filter(
    (lib) => !stdout.includes(`--enable-${lib}`),
  );
  if (missing.length > 0) throw new Error(`ffmpeg ${version} is missing: ${missing.join(", ")}`);
  return `${version} · libass + HarfBuzz present (Bangla captions OK)`;
}

async function checkFfprobe(env: LocalEnv): Promise<string> {
  const { stdout } = await execFile(env.FFPROBE_PATH, ["-hide_banner", "-version"]);
  return /ffprobe version (\S+)/.exec(stdout)?.[1] ?? "found";
}

async function checkYtdlp(env: LocalEnv): Promise<string> {
  const { stdout } = await execFile(env.YTDLP_PATH, ["--version"]);
  return stdout.trim();
}

async function checkScratch(env: LocalEnv): Promise<string> {
  await mkdir(env.SCRATCH_DIR, { recursive: true });
  const probe = path.join(env.SCRATCH_DIR, `.write-test-${process.pid}`);
  await writeFile(probe, "ok");
  const back = await readFile(probe, "utf8");
  await rm(probe, { force: true });
  if (back !== "ok") throw new Error("wrote a file but read back something else");

  const drive = path.parse(env.SCRATCH_DIR).root.toUpperCase();
  if (process.platform === "win32" && drive.startsWith("C:")) {
    throw new Error(`${env.SCRATCH_DIR} is on C: (the SSD is nearly full)`);
  }
  return `writable · ${env.SCRATCH_DIR}`;
}

// ── Run ─────────────────────────────────────────────────────

async function main() {
  loadEnvFile();

  console.log("\nChecking worker/.env.local and local tools\n");

  const notOnPath = (tool: string) => (m: string) =>
    /ENOENT/.test(m) ? `${tool} not found — open a NEW terminal (PATH changed) or set the path in .env.local` : m;

  const local = localEnvSchema.parse(process.env);
  const localResults = await Promise.all([
    check("FFmpeg", () => checkFfmpeg(local), notOnPath("ffmpeg")),
    check("FFprobe", () => checkFfprobe(local), notOnPath("ffprobe")),
    check("yt-dlp", () => checkYtdlp(local), notOnPath("yt-dlp")),
    check("Scratch dir", () => checkScratch(local), () => "set SCRATCH_DIR in .env.local to a folder on D:"),
  ]);

  const parsed = workerEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.log("✗ Some variables are missing or malformed (cloud checks skipped):\n");
    for (const line of formatEnvIssues(parsed.error)) console.log(`  - ${line}`);
    console.log("");
    report(localResults, 1);
    return;
  }
  const env = parsed.data;
  console.log("✓ All variables present and well-formed\n");

  const cloudResults = await Promise.all([
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
    check("Groq", () => checkGroq(env), (m) =>
      /401|403/.test(m) ? "GROQ_API_KEY is wrong — create a new one at console.groq.com" : "check your internet connection"),
    check("Gemini", () => checkGemini(env), (m) =>
      /400|401|403/.test(m) ? "GEMINI_API_KEY is wrong — aistudio.google.com/apikey" : "check your internet connection"),
  ]);

  report([...cloudResults, ...localResults], 0);
}

/** Prints results and exits; `extraFailures` counts problems found before the checks ran. */
function report(results: Result[], extraFailures: number): never {
  for (const r of results) {
    console.log(`${r.ok ? "✓" : "✗"} ${r.name.padEnd(12)} ${r.detail}`);
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks OK\n`);
  process.exit(passed === results.length && extraFailures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Unexpected error:", errorMessage(err));
  process.exit(1);
});
