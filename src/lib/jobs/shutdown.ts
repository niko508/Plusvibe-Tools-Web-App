import "server-only";

// Best-effort "flush on shutdown" registry. Railway (and most PaaS) replace the
// container on every deploy: the old process gets SIGTERM, then SIGKILL after a
// short grace period. Any job running in memory dies with it. We can't keep the
// work going, but we CAN persist the last-known state synchronously before the
// process exits, so a killed job shows up as "interrupted" (with accurate
// progress) instead of vanishing — provided the job records live on a
// persistent volume (see JOBS_DIR / README).

type FlushFn = () => void;

const flushers = new Set<FlushFn>();
let registered = false;

export function onShutdownFlush(fn: FlushFn) {
  flushers.add(fn);
  if (registered) return;
  registered = true;

  let ran = false;
  const handler = (signal: NodeJS.Signals) => {
    if (ran) return;
    ran = true;
    for (const f of flushers) {
      try {
        f();
      } catch {
        // best-effort — never let a flush error block shutdown
      }
    }
    // Re-raise so the default handler terminates the process normally.
    try {
      process.kill(process.pid, signal);
    } catch {
      process.exit(0);
    }
  };

  process.once("SIGTERM", handler);
  process.once("SIGINT", handler);
}
