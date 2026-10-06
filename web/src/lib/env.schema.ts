import { z } from "zod";

/**
 * Rules for every environment variable the web app needs.
 *
 * Kept free of `server-only` so standalone scripts (scripts/check-services.ts)
 * can import it. App code should import `env` from "@/lib/env" instead.
 */
/** An optional variable; an empty value (`KEY=` copied from .env.example) counts as unset. */
const optional = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

export const serverEnvSchema = z.object({
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z
    .string()
    .min(1, "missing — copy it from Clerk → API Keys")
    .startsWith("pk_", "should start with pk_ (did you swap it with the secret key?)"),
  CLERK_SECRET_KEY: z
    .string()
    .min(1, "missing — copy it from Clerk → API Keys")
    .startsWith("sk_", "should start with sk_"),

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

  // Optional, admin panel only (AI models page): live model lists and the "Test" button.
  // The worker makes every real AI call with its own copies. Without them the page still
  // saves settings, but can't list models or test one.
  GEMINI_API_KEY: optional(z.string().regex(/^\S{20,}$/, "looks truncated or contains spaces — copy it again")),
  GROQ_API_KEY: optional(z.string().startsWith("gsk_", "should start with gsk_")),

  // Owners. A user whose *verified* primary Clerk email is listed becomes an admin
  // (docs/ADMIN.md §1). Kept in env so no request to the app can create an admin.
  ADMIN_EMAILS: z
    .string()
    .min(1, "missing — comma-separated owner emails, e.g. you@example.com")
    .transform((v) =>
      v
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    )
    .pipe(z.array(z.email("contains something that isn't an email address")).min(1, "needs at least one email")),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

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
