// Runs async tasks over a list with a bounded number in flight at once, plus a
// minimum spacing between task starts. This keeps us comfortably under the
// Plusvibe rate limit (5 requests/second) while fanning out per-domain stats.

export interface MapPoolOptions {
  concurrency?: number;
  minSpacingMs?: number;
  signal?: AbortSignal;
}

export async function mapPool<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  options: MapPoolOptions = {}
): Promise<R[]> {
  const { concurrency = 4, minSpacingMs = 0, signal } = options;
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let lastStart = 0;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function runOne(): Promise<void> {
    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const index = nextIndex++;
      if (index >= items.length) return;

      if (minSpacingMs > 0) {
        const now = Date.now();
        const wait = lastStart + minSpacingMs - now;
        if (wait > 0) await sleep(wait);
        lastStart = Date.now();
      }

      results[index] = await worker(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => runOne()
  );
  await Promise.all(workers);
  return results;
}
