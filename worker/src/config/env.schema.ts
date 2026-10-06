import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

/** Absolute path of the worker/ folder, regardless of the current directory. */
export const WORKER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Loads worker/.env.local into process.env if it exists.
 * Variables already set (e.g. Hugging Face Space secrets) are not overwritten.
 */
export function loadEnvFile(): void {
  const file = path.join(WORKER_ROOT, ".env.local");
  if (existsSync(file)) process.loadEnvFile(file);
}

/** Resolves a path relative to worker/ unless it is already absolute. */
const workerPath = z
  .string()
  .min(1)
  .transform((p) => path.resolve(WORKER_ROOT, p));

export const workerEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  MONGODB_URI: z
    .string()
    .min(1, "missing — Atlas → Connect → Drivers")
    .regex(/^mongodb(\+srv)?:\/\//, "should start with mongodb+srv://")
    .refine((v) => !/<[^>]*password[^>]*>/i.test(v), "still contains the <db_password> placeholder"),
  MONGODB_DB: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/, "letters, digits, _ and - only")
    .default("ai_video_shorter"),

  REDIS_URL: z
    .string()
    .min(1, "missing — Redis Cloud → your database → Connect")
    .regex(/^rediss?:\/\//, "should start with redis://"),

  CLOUDINARY_CLOUD_NAME: z.string().min(1, "missing — Cloudinary dashboard"),
  CLOUDINARY_API_KEY: z
    .string()
    .min(1, "missing — Cloudinary → API Keys")
    .regex(/^\d+$/, "Cloudinary API keys are digits only"),
  CLOUDINARY_API_SECRET: z.string().min(1, "missing — Cloudinary → API Keys"),
  CLOUDINARY_FOLDER: z
    .string()
    .regex(/^[a-z0-9_-]+$/, "lowercase letters, digits, _ and - only")
    .default("dev"),

  GROQ_API_KEY: z
    .string()
    .min(1, "missing — console.groq.com → API Keys")
    .startsWith("gsk_", "should start with gsk_"),
  // Google issues more than one key format (legacy "AIza…", newer "AQ.…"),
  // so only check that it looks like a single token; the check script verifies it works.
  GEMINI_API_KEY: z
    .string()
    .min(1, "missing — aistudio.google.com/apikey")
    .regex(/^\S{20,}$/, "looks truncated or contains spaces — copy it again"),

  SCRATCH_DIR: workerPath.default(".scratch"),
  FFMPEG_PATH: z.string().min(1).default("ffmpeg"),
  FFPROBE_PATH: z.string().min(1).default("ffprobe"),
  YTDLP_PATH: z.string().min(1).default("yt-dlp"),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/**
 * One line per variable (its first problem only — an empty value would otherwise
 * also fail every format rule). Names the variable, never prints its value.
 */
export function formatEnvIssues(error: z.ZodError): string[] {
  const firstByVar = new Map<string, string>();
  for (const issue of error.issues) {
    const name = issue.path.join(".") || "(root)";
    if (!firstByVar.has(name)) firstByVar.set(name, issue.message);
  }
  return [...firstByVar].map(([name, message]) => `${name}: ${message}`);
}
