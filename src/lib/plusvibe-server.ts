import "server-only";

// Server-side Plusvibe API client. This module is the ONLY place that talks to
// the Plusvibe API, so the `x-api-key` never reaches the browser bundle. The
// key is resolved per request: a caller-supplied key (forwarded from the UI)
// takes precedence, falling back to the PLUSVIBE_API_KEY env var when set.

const BASE_URL = "https://api.plusvibe.ai/api/v1";

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
  const fromHeader = request.headers.get(CLIENT_KEY_HEADER)?.trim();
  const key = fromHeader || process.env.PLUSVIBE_API_KEY?.trim();
  if (!key) {
    throw new PlusvibeError(
      "No Plusvibe API key provided. Add your key in the app settings.",
      401
    );
  }
  return key;
}

interface RequestOptions {
  apiKey: string;
  path: string;
  query?: Record<string, string | undefined>;
  // Number of retry attempts on 429 / 5xx before giving up.
  retries?: number;
  signal?: AbortSignal;
}

interface FullRequestOptions extends RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH";
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
      res = await fetch(url, {
        method,
        headers,
        body: payload,
        signal,
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
