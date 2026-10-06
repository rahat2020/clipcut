/**
 * Cleanup hooks run on SIGINT/SIGTERM, last registered first (close queues before the
 * database they write to). Kept separate from index.ts so any module can register one
 * without importing the entry point.
 */
type ShutdownHook = () => Promise<void>;

const hooks: ShutdownHook[] = [];
let running = false;

export function onShutdown(hook: ShutdownHook): void {
  hooks.push(hook);
}

/** Runs every hook once, reporting failures instead of stopping at the first one. */
export async function runShutdownHooks(onError: (err: unknown) => void): Promise<void> {
  if (running) return;
  running = true;
  for (const hook of [...hooks].reverse()) {
    try {
      await hook();
    } catch (err) {
      onError(err);
    }
  }
}
