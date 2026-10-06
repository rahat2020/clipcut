import { AppError } from "../../shared";

/** Seconds from Google's "37s" / "1.5s" retry delays. */
export function parseSeconds(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const m = /^(\d+(?:\.\d+)?)s$/.exec(value.trim());
  return m ? Number(m[1]) : undefined;
}

/** Wraps a fetch so network failures and our own timeout become AI_UNAVAILABLE. */
export async function postJson(
  url: string,
  init: { headers: Record<string, string>; body: unknown; timeoutMs: number; signal?: AbortSignal },
): Promise<{ res: Response; bodyText: string; latencyMs: number }> {
  const timeout = AbortSignal.timeout(init.timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...init.headers },
      body: JSON.stringify(init.body),
      signal,
    });
    const bodyText = await res.text();
    return { res, bodyText, latencyMs: Date.now() - t0 };
  } catch (cause) {
    if (init.signal?.aborted) throw cause;
    const timedOut = timeout.aborted;
    throw new AppError("AI_UNAVAILABLE", {
      cause,
      message: timedOut ? "The AI took too long to answer. We'll retry." : undefined,
      // A slow model stays slow for a while: after a timeout, go straight to the next one.
      details: { network: true, timedOut, noRetry: timedOut },
    });
  }
}
