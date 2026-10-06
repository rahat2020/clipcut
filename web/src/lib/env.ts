import "server-only";

import { formatEnvIssues, serverEnvSchema } from "./env.schema";

/**
 * Validated server environment. Import this instead of reading process.env.
 * A missing or malformed variable stops the server with a clear message
 * instead of failing later with `undefined`.
 */
function loadEnv() {
  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const lines = formatEnvIssues(parsed.error).map((l) => `  - ${l}`);
    throw new Error(
      `Invalid environment variables in web/.env.local:\n${lines.join("\n")}\n` +
        `Run "npm run check" in web/ for details.`,
    );
  }
  return parsed.data;
}

export const env = loadEnv();
