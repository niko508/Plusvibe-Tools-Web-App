import "server-only";

// A single global rate limiter shared by every background job manager. A
// Plusvibe account has one 5 req/s budget, so ALL delete/update starts — no
// matter which tool or job triggered them — must pass through this one gate.

const SLOT_SPACING_MS = 220; // ~4.5 request starts/sec, globally

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let slotChain: Promise<void> = Promise.resolve();
let lastSlot = 0;

// Serializes slot acquisition so request starts are spaced >= SLOT_SPACING_MS
// apart no matter how many workers/jobs/tools are active concurrently.
export function acquireSlot(): Promise<void> {
  const p = slotChain.then(async () => {
    const wait = Math.max(0, lastSlot + SLOT_SPACING_MS - Date.now());
    if (wait > 0) await sleep(wait);
    lastSlot = Date.now();
  });
  slotChain = p.catch(() => {});
  return p;
}
