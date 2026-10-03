import "server-only";

// Server-side Plusvibe API client. This module is the ONLY place that talks to
// the Plusvibe API, so the `x-api-key` never reaches the browser bundle. The
// key is the caller's own, forwarded from the UI. PLUSVIBE_API_KEY on the
// server is for the unattended automations only: a request that brings no key
// of its own is refused, never run on the server's.

// Overridable so the unattended automations can be exercised end to end
// against a stand-in API. Unset in production, which is the real endpoint.
const BASE_URL =
  process.env.PLUSVIBE_BASE_URL?.trim().replace(/\/+$/, "") ||
  "https://api.plusvibe.ai/api/v1";

// Header the UI uses to forward the user's key to our proxy routes.
export const CLIENT_KEY_HEADER = "x-pv-key";

export class PlusvibeError extends Error {
  status: number;
  details?: unknown;
  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = "PlusvibeError";
    this.status = status;
    this.details = details;
  }
}

export function resolveApiKey(request: Request): string {
  // No falling back to the server's key: the app is on a public URL, and that
  // would hand the whole Plusvibe account to anyone who found it.
  const key = request.headers.get(CLIENT_KEY_HEADER)?.trim();
  if (!key) {
    throw new PlusvibeError(
      "No Plusvibe API key provided. Add your key in the app settings.",
      401
    );
  }
  return key;
}

const VERIFY_OK_MS = 10 * 60 * 1000;
const VERIFY_NO_MS = 60 * 1000;
const verified: Map<string, { ok: boolean; at: number }> = ((globalThis as { __pvVerifiedKeys?: Map<string, { ok: boolean; at: number }> }).__pvVerifiedKeys ??=
  new Map());

async function workspaceIdsOf(apiKey: string): Promise<Set<string>> {
  const data = await plusvibeGet<{ workspaces?: { _id?: string }[] }>({ apiKey, path: "/authenticate", retries: 1 });
  return new Set((data.workspaces ?? []).map((w) => w?._id).filter((id): id is string => !!id));
}

/**
 * For routes that act with the server's own key — the shared logs of the
 * unattended automations. Having some key in the header isn't enough there,
 * since any string would do: the key has to be the server's, or one Plusvibe
 * accepts that sees at least one of the same workspaces. Checked answers are
 * remembered for a few minutes, so the page's polling costs nothing.
 */
export async function requireAccountKey(request: Request): Promise<string> {
  const key = resolveApiKey(request);
  const serverKey = process.env.PLUSVIBE_API_KEY?.trim();
  if (!serverKey || key === serverKey) return key;
  const hit = verified.get(key);
  if (hit && Date.now() - hit.at < (hit.ok ? VERIFY_OK_MS : VERIFY_NO_MS)) {
    if (hit.ok) return key;
    throw new PlusvibeError("This Plusvibe API key isn't for this account.", 403);
  }
  let ok = false;
  try {
    const [mine, server] = await Promise.all([workspaceIdsOf(key), workspaceIdsOf(serverKey)]);
    ok = [...mine].some((id) => server.has(id));
  } catch (err) {
    // Plusvibe refusing the key is an answer; Plusvibe being down is not.
    if (!(err instanceof PlusvibeError && (err.status === 401 || err.status === 403))) throw err;
  }
  verified.set(key, { ok, at: Date.now() });
  if (verified.size > 100) verified.delete(verified.keys().next().value as string);
  if (!ok) throw new PlusvibeError("This Plusvibe API key isn't for this account.", 403);
  return key;
}

/** How long one Plusvibe request may take before it counts as failed (and is retried). */
const REQUEST_TIMEOUT_MS = 90_000;

interface RequestOptions {
  apiKey: string;
  path: string;
  query?: Record<string, string | undefined>;
  // Number of retry attempts on 429 / 5xx before giving up.
  retries?: number;
  signal?: AbortSignal;
}

interface FullRequestOptions extends RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
}

function buildUrl(path: string, query?: Record<string, string | undefined>) {
  const url = new URL(BASE_URL + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    }
  }
  return url.toString();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Shared request loop with retry/backoff on transient failures (429 / 5xx).
// 4xx (e.g. 400, 404) are surfaced immediately as PlusvibeError, not retried.
async function plusvibeRequest<T>({
  apiKey,
  path,
  query,
  method = "GET",
  body,
  retries = 2,
  signal,
}: FullRequestOptions): Promise<T> {
  const url = buildUrl(path, query);
  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    accept: "application/json",
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  const payload = body !== undefined ? JSON.stringify(body) : undefined;

  let attempt = 0;
  while (true) {
    let res: Response;
    try {
      // A request Plusvibe never answers would otherwise hold its caller —
      // and, in the automations, a whole run — forever.
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      res = await fetch(url, {
        method,
        headers,
        body: payload,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        cache: "no-store",
      });
    } catch (err) {
      if (attempt < retries) {
        await sleep(300 * Math.pow(2, attempt));
        attempt++;
        continue;
      }
      throw new PlusvibeError(
        `Network error contacting Plusvibe: ${(err as Error).message}`,
        502
      );
    }

    if (res.status === 429 || res.status >= 500) {
      if (attempt < retries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 400 * Math.pow(2, attempt);
        await sleep(waitMs);
        attempt++;
        continue;
      }
    }

    const text = await res.text();
    let respBody: unknown = undefined;
    if (text) {
      try {
        respBody = JSON.parse(text);
      } catch {
        respBody = text;
      }
    }

    if (!res.ok) {
      const message =
        extractErrorMessage(respBody) ?? `Plusvibe request failed (${res.status})`;
      throw new PlusvibeError(message, res.status, respBody);
    }

    return respBody as T;
  }
}

export function plusvibeGet<T>(options: RequestOptions): Promise<T> {
  return plusvibeRequest<T>({ ...options, method: "GET" });
}

export function plusvibePost<T>(
  options: RequestOptions & { body: unknown }
): Promise<T> {
  return plusvibeRequest<T>({ ...options, method: "POST" });
}

export function plusvibePut<T>(
  options: RequestOptions & { body: unknown }
): Promise<T> {
  return plusvibeRequest<T>({ ...options, method: "PUT" });
}

export function plusvibePatch<T>(
  options: RequestOptions & { body: unknown }
): Promise<T> {
  return plusvibeRequest<T>({ ...options, method: "PATCH" });
}

/** DELETE with a body — which is how Plusvibe's delete endpoints take their ids. */
export function plusvibeDelete<T>(
  options: RequestOptions & { body: unknown }
): Promise<T> {
  return plusvibeRequest<T>({ ...options, method: "DELETE" });
}

function extractErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") {
    return typeof body === "string" && body ? body : undefined;
  }
  const b = body as Record<string, unknown>;
  if (Array.isArray(b.errors) && b.errors.length) {
    return (b.errors as unknown[]).map(String).join("; ");
  }
  if (typeof b.message === "string") return b.message;
  if (typeof b.error === "string") return b.error;
  return undefined;
}
