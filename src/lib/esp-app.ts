import "server-only";

import { cleanEspUrl } from "@/lib/esp-url";

// The ESP Matching & Campaign Limits app, a separate service. Its Manual Run
// sets a workspace's pool tags, inbox limits and campaign daily limits from
// the campaigns and leads it finds, so the workspace flow runs it once the
// leads are in place.
//
//   POST /api/run     { workspaceIds: [id] } -> 202 started | 409 a run is going
//   GET  /api/status  -> { running, lastRun: { startedAt, finishedAt, trigger, ok, failed, report, error } }
//   POST /api/login   { password } -> sets the "sid" cookie (only when the app has a password)
//
// ESP_APP_URL is the app's address; ESP_APP_PASSWORD its APP_PASSWORD, if set.

const baseUrl = () => cleanEspUrl(process.env.ESP_APP_URL);
const password = () => cleanSecret(process.env.ESP_APP_PASSWORD);

/** The password, without a pasted "NAME=" or surrounding quotes. */
function cleanSecret(raw: string | undefined): string {
  let v = (raw ?? "").trim();
  v = v.replace(/^ESP_APP_PASSWORD\s*=\s*/, "");
  return v.replace(/^(["'])(.*)\1$/, "$2");
}

export function espConfigured(): boolean {
  return baseUrl() !== "";
}

/** Set, but not something an address can be read from. */
export function espUrlInvalid(): boolean {
  return (process.env.ESP_APP_URL ?? "").trim() !== "" && baseUrl() === "";
}

export const ESP_NOT_CONNECTED =
  "The ESP app isn't connected: set ESP_APP_URL (and ESP_APP_PASSWORD, if it has a password) on this app's Railway service.";
export const ESP_URL_INVALID =
  "ESP_APP_URL on this app's Railway service isn't an address: its value should be just the ESP app's link, e.g. https://….up.railway.app.";

export interface EspOutcome {
  ok: boolean;
  startedAt?: number;
  finishedAt?: number;
  report?: string;
  error?: string;
}

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

export interface EspRunOptions {
  /** Throws to stop (the job was stopped). */
  check: () => void;
  /** Called with true while the ESP app is busy with another run, false once ours started. */
  onWaiting?: (waiting: boolean) => Promise<void> | void;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  /** Longest wait, for a busy app and our own run together. */
  maxMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Runs the ESP app's Manual Run for one workspace and waits for it to finish.
 * Throws when the app can't be reached, refuses, or doesn't finish in time;
 * returns the app's own verdict otherwise.
 */
export async function runEspManual(workspaceId: string, opts: EspRunOptions): Promise<EspOutcome> {
  if (espUrlInvalid()) throw new Error(ESP_URL_INVALID);
  if (!espConfigured()) throw new Error(ESP_NOT_CONNECTED);
  const sleep = opts.sleep ?? defaultSleep;
  const pollMs = opts.pollMs ?? 5000;
  const deadline = Date.now() + (opts.maxMs ?? 45 * 60_000);
  let cookie = "";

  async function login(): Promise<void> {
    const res = await fetch(`${baseUrl()}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: password() }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401) throw new Error("The ESP app turned down ESP_APP_PASSWORD.");
    if (!res.ok) throw new Error(`The ESP app's sign-in answered ${res.status}.`);
    const sid = /(?:^|[;,]\s*)sid=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    if (!sid) throw new Error("The ESP app's sign-in didn't return a session.");
    cookie = `sid=${sid}`;
  }

  /** One call, signed in when needed, retried through a restart or a dropped connection. */
  async function call(path: string, method: "GET" | "POST", body?: unknown): Promise<Reply> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(`${baseUrl()}${path}`, {
          method,
          headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(30_000),
        });
        if (res.status === 401) {
          if (!password()) throw new Error("The ESP app asks for a password: set ESP_APP_PASSWORD on this app's Railway service.");
          if (cookie && attempt > 0) throw new Error("The ESP app keeps asking to sign in.");
          await login();
          continue;
        }
        if (res.status >= 500 && attempt < 6) {
          await sleep(10_000);
          continue;
        }
        const text = await res.text();
        let parsed: unknown = {};
        try {
          parsed = text ? JSON.parse(text) : {};
        } catch {
          parsed = {};
        }
        return { status: res.status, body: (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown> };
      } catch (err) {
        // A network failure: the app restarting or a deploy. Anything we threw
        // ourselves above is final.
        if (!(err instanceof TypeError || (err instanceof Error && err.name === "TimeoutError")) || attempt >= 6) throw err;
        await sleep(10_000);
      }
    }
  }

  // Start it, waiting behind a run the app is already doing.
  let startedAt = 0;
  for (;;) {
    opts.check();
    const r = await call("/api/run", "POST", { workspaceIds: [workspaceId] });
    if (r.status === 202) {
      startedAt = Date.now();
      break;
    }
    if (r.status === 409) {
      await opts.onWaiting?.(true);
      if (Date.now() > deadline) throw new Error("The ESP app was busy with another run the whole time; run its Manual Run for this workspace by hand.");
      await sleep(15_000);
      continue;
    }
    throw new Error(`The ESP app refused the run (${r.status}${typeof r.body.error === "string" ? `: ${r.body.error}` : ""}).`);
  }
  await opts.onWaiting?.(false);

  // Then wait for it to finish.
  for (;;) {
    await sleep(pollMs);
    opts.check();
    const r = await call("/api/status", "GET");
    if (r.status !== 200) throw new Error(`The ESP app's status answered ${r.status}.`);
    if (r.body.running) {
      if (Date.now() > deadline) throw new Error("The ESP Manual Run hadn't finished after 45 minutes; check it in the ESP app.");
      continue;
    }
    const last = (r.body.lastRun ?? null) as Record<string, unknown> | null;
    const lastStart = last ? Date.parse(String(last.startedAt ?? "")) : NaN;
    // Two minutes' grace for the two servers' clocks.
    if (!last || !(lastStart >= startedAt - 120_000)) throw new Error("The ESP app finished, but its last run isn't this one; check it in the ESP app.");
    const finished = Date.parse(String(last.finishedAt ?? ""));
    return {
      ok: last.ok === true,
      startedAt: lastStart,
      ...(Number.isFinite(finished) ? { finishedAt: finished } : {}),
      ...(typeof last.report === "string" ? { report: last.report } : {}),
      ...(typeof last.error === "string" ? { error: last.error } : last.ok === true ? {} : { error: `${Number(last.failed) || 1} workspace(s) failed in the ESP app` }),
    };
  }
}
