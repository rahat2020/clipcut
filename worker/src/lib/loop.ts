import { logger } from "./logger";

/**
 * Runs `task` now and then again `intervalMs` after each run finishes (never
 * overlapping). A failing run is logged and the loop keeps going. Returns `stop`,
 * which waits for a run in progress to end.
 */
export function every(name: string, intervalMs: number, task: () => Promise<void>): () => Promise<void> {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let running: Promise<void> | null = null;

  const tick = () => {
    running = task()
      .catch((err: unknown) => logger.error({ err, loop: name }, "background loop failed"))
      .finally(() => {
        running = null;
        if (!stopped) timer = setTimeout(tick, intervalMs);
      });
  };
  tick();

  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await running;
  };
}
