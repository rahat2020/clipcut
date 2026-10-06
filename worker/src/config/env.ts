import { formatEnvIssues, loadEnvFile, workerEnvSchema } from "./env.schema";

/**
 * Validated worker environment. Import this instead of reading process.env.
 * A missing or malformed variable stops the worker at boot with a clear message.
 */
function loadEnv() {
  loadEnvFile();
  const parsed = workerEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const lines = formatEnvIssues(parsed.error).map((l) => `  - ${l}`);
    throw new Error(
      `Invalid environment variables in worker/.env.local:\n${lines.join("\n")}\n` +
        `Run "npm run check" in worker/ for details.`,
    );
  }
  return parsed.data;
}

export const env = loadEnv();
