import pino from "pino";

import { env } from "../config/env";

/**
 * Structured JSON logs in production, readable colored lines in development.
 * Secrets are redacted if they ever end up in a logged object.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: "worker" },
  redact: {
    paths: ["*.apiKey", "*.api_key", "*.apiSecret", "*.api_secret", "*.password", "*.token", "*.uri", "*.url"],
    censor: "[redacted]",
  },
  transport:
    env.NODE_ENV === "development"
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname,service" } }
      : undefined,
});
