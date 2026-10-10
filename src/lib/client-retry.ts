// Retrying a browser-driven run's requests through a rate limit, a server
// error, a dropped connection or the app restarting during a deploy.

import { ApiClientError } from "@/lib/api-client";

/** Waits before each retry, in seconds — about a minute and a half in all, enough to ride out a redeploy. */
export const RETRY_WAITS = [2, 4, 8, 15, 30, 30];

/** A rate limit, a server error or a dropped connection — worth trying again. */
export function isTransient(err: unknown): boolean {
  if (err instanceof ApiClientError) return err.status === 429 || err.status >= 500;
  return err instanceof TypeError; // fetch's "Failed to fetch"
}

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

export async function withRetry<T>(fn: () => Promise<T>, signal: AbortSignal, onWait: (secs: number) => void): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (signal.aborted || !isTransient(err) || attempt >= RETRY_WAITS.length) throw err;
      onWait(RETRY_WAITS[attempt]);
      await wait(RETRY_WAITS[attempt] * 1000, signal);
    }
  }
}
