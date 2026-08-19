import "server-only";

import { createHash, randomUUID } from "crypto";
import { promises as fs, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { plusvibeGet, plusvibePut, plusvibePatch } from "@/lib/plusvibe-server";
import { acquireSlot } from "@/lib/jobs/rate-limit";
import { onShutdownFlush } from "@/lib/jobs/shutdown";
import {
  batchUpdateCells,
  columnLetter,
  quoteTab,
  readTab,
  type CellUpdate,
} from "@/lib/google-sheets";
import { extractSheetId } from "@/lib/sheet";
import type {
  AzureDomainRow,
  AzureStartPayload,
  AzureUploadRow,
  AzureWarmupJob,
} from "@/lib/jobs/azure-warmup-types";
import {
  CHECK_INTERVAL_MS,
  COL_DOMAIN,
  COL_STATUS,
  COL_TENANT_EMAIL,
  MAX_CONSECUTIVE_FAILURES,
  MAX_RUN_MS,
  MAX_STORED_ERRORS,
  STATUS_WARMING_UP,
} from "@/lib/jobs/azure-warmup-types";

// Server-side manager for the Azure warmup workflow.
//
// A run has three phases and can span days:
//   1. wait out the configured delay
//   2. write Tenant Email Address + Status into the Domains sheet
//   3. poll Plusvibe hourly, and for every uploaded inbox that has appeared,
//      apply the warmup settings and switch warmup on
// It finishes when every uploaded inbox is warming, or after 7 days — whichever
// comes first. Inboxes that never appeared are listed for troubleshooting.
//
// Because a run outlives any deploy, the full state (including the uploaded
// rows) is persisted so an interrupted job can be resumed with a fresh API key.

const JOBS_BASE = process.env.JOBS_DIR || path.join(process.cwd(), ".jobs-data");
const JOBS_DIR = path.join(JOBS_BASE, "azure-warmup");
const ACCOUNTS_PAGE = 100;
const ACCOUNTS_MAX_PAGES = 400; // 40k inboxes
const BULK_CHUNK = 100; // inboxes per warmup update call

// The warmup config applied to every inbox this tool starts.
const WARMUP_SETTINGS = {
  warmup_max_daily_limit: 18,
  bulk_warmup_is_slow_rampup: "yes",
  warmup_initial_daily_limit: 2,
  warmup_pace_increment: 3,
  warmup_randomize: "yes",
  warmup_randomize_num: 10,
  warmup_reply_rate: 0.46, // the API uses 0-1, so 46% is 0.46
  warmup_schedule: {
    tz: "America/New_York",
    from_time: "00:00",
    to_time: "23:59",
    days: [
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ],
  },
} as const;

interface JobMeta {
  fingerprint: string;
  apiKey?: string;
  aborted: boolean;
  running: boolean;
}

/** Persisted shape — the client-facing record plus the data needed to resume. */
interface StoredJob extends AzureWarmupJob {
  workspaceId: string;
  sheetUrl: string;
  rows: AzureUploadRow[];
  /** Emails already configured + switched on, so a resume doesn't redo them. */
  done: string[];
}

const records = new Map<string, StoredJob>();
const meta = new Map<string, JobMeta>();
let loaded = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Persistence -----------------------------------------------------------

function fingerprintKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

const fileFor = (id: string) => path.join(JOBS_DIR, `${id}.json`);

async function persist(id: string) {
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m) return;
  try {
    await fs.mkdir(JOBS_DIR, { recursive: true });
    await fs.writeFile(
      fileFor(id),
      JSON.stringify({ ...rec, fingerprint: m.fingerprint }),
      "utf8"
    );
  } catch {
    // best-effort
  }
}

function flushRunningSync() {
  let any = false;
  for (const [, rec] of records) {
    if (rec.status === "running" || rec.status === "waiting") {
      any = true;
      break;
    }
  }
  if (!any) return;
  try {
    mkdirSync(JOBS_DIR, { recursive: true });
  } catch {
    return;
  }
  for (const [id, rec] of records) {
    if (rec.status !== "running" && rec.status !== "waiting") continue;
    const m = meta.get(id);
    if (!m) continue;
    rec.status = "interrupted";
    rec.updatedAt = Date.now();
    try {
      writeFileSync(
        fileFor(id),
        JSON.stringify({ ...rec, fingerprint: m.fingerprint }),
        "utf8"
      );
    } catch {
      // best-effort
    }
  }
}

onShutdownFlush(flushRunningSync);

async function loadOnce() {
  if (loaded) return;
  loaded = true;
  try {
    await fs.mkdir(JOBS_DIR, { recursive: true });
    for (const f of await fs.readdir(JOBS_DIR)) {
      if (!f.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(
          await fs.readFile(path.join(JOBS_DIR, f), "utf8")
        ) as StoredJob & { fingerprint?: string };
        const fingerprint = parsed.fingerprint ?? "";
        delete (parsed as { fingerprint?: string }).fingerprint;
        if (parsed.status === "running" || parsed.status === "waiting") {
          parsed.status = "interrupted";
        }
        parsed.rows = parsed.rows ?? [];
        parsed.done = parsed.done ?? [];
        records.set(parsed.id, parsed);
        meta.set(parsed.id, { fingerprint, aborted: false, running: false });
      } catch {
        // skip corrupt record
      }
    }
  } catch {
    // nothing stored yet
  }
}

/** Strips the server-only fields before the record goes to the browser. */
function toClient(rec: StoredJob): AzureWarmupJob {
  const {
    workspaceId: _w,
    sheetUrl: _u,
    rows: _r,
    done: _d,
    ...client
  } = rec;
  void _w;
  void _u;
  void _r;
  void _d;
  return client;
}

// --- Creation --------------------------------------------------------------

export async function createJob(
  apiKey: string,
  payload: AzureStartPayload
): Promise<string> {
  await loadOnce();
  const id = randomUUID();
  const now = Date.now();
  const startsAt = now + Math.max(0, payload.delayHours) * 60 * 60 * 1000;

  const byDomain = new Map<string, AzureDomainRow>();
  for (const row of payload.rows) {
    const existing = byDomain.get(row.domain);
    if (existing) existing.total += 1;
    else
      byDomain.set(row.domain, {
        domain: row.domain,
        orderEmail: row.orderEmail,
        total: 1,
        found: 0,
        warmed: 0,
        sheetUpdated: false,
      });
  }
  const domains = Array.from(byDomain.values()).sort((a, b) =>
    a.domain.localeCompare(b.domain)
  );

  const rec: StoredJob = {
    id,
    label: `${domains.length} domains · ${payload.rows.length} inboxes`,
    status: payload.delayHours > 0 ? "waiting" : "running",
    phase: payload.delayHours > 0 ? "waiting" : "sheet",
    createdAt: now,
    updatedAt: now,
    startsAt,
    deadlineAt: startsAt + MAX_RUN_MS,
    workspaceName: payload.workspaceName,
    sheetTab: payload.sheetTab,
    totals: {
      domains: domains.length,
      inboxes: payload.rows.length,
      found: 0,
      warmed: 0,
    },
    domains,
    sheet: { attempted: false, rowsUpdated: 0, notFound: [] },
    missing: payload.rows.map((r) => r.email),
    checks: 0,
    nextCheckAt: startsAt,
    errors: [],
    workspaceId: payload.workspaceId,
    sheetUrl: payload.sheetUrl,
    rows: payload.rows,
    done: [],
  };

  records.set(id, rec);
  meta.set(id, { fingerprint: fingerprintKey(apiKey), apiKey, aborted: false, running: false });
  await persist(id);
  void runJob(id);
  return id;
}

/** Restarts an interrupted job from persisted state with a fresh key. */
export async function resumeJob(apiKey: string, id: string): Promise<boolean> {
  await loadOnce();
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m || m.fingerprint !== fingerprintKey(apiKey)) return false;
  if (m.running) return true;
  if (rec.status !== "interrupted" && rec.status !== "error") return false;
  if (rec.rows.length === 0) return false;

  m.apiKey = apiKey;
  m.aborted = false;
  rec.status = Date.now() < rec.startsAt ? "waiting" : "running";
  rec.updatedAt = Date.now();
  await persist(id);
  void runJob(id);
  return true;
}

// --- Runner ----------------------------------------------------------------

async function runJob(id: string) {
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m || !m.apiKey || m.running) return;
  m.running = true;
  const apiKey = m.apiKey;

  try {
    // --- Phase 1: wait out the delay -------------------------------------
    while (Date.now() < rec.startsAt) {
      if (m.aborted) throw new Aborted();
      rec.status = "waiting";
      rec.phase = "waiting";
      rec.nextCheckAt = rec.startsAt;
      await sleep(Math.min(60_000, rec.startsAt - Date.now()));
    }
    if (m.aborted) throw new Aborted();
    rec.status = "running";

    // --- Phase 2: update the Domains sheet -------------------------------
    if (!rec.sheet.attempted) {
      rec.phase = "sheet";
      rec.updatedAt = Date.now();
      await persist(id);
      try {
        await updateDomainsSheet(rec);
      } catch (err) {
        rec.sheet.error = msg(err);
        pushError(rec, `Sheet update failed: ${msg(err)}`);
        // Not fatal: the Plusvibe half is the important part, so keep going.
      }
      rec.sheet.attempted = true;
      await persist(id);
    }

    // --- Phase 3: hourly polling -----------------------------------------
    rec.phase = "polling";
    const doneSet = new Set(rec.done);

    let consecutiveFailures = 0;
    let hadSuccess = false;

    while (true) {
      if (m.aborted) throw new Aborted();

      // A check must never kill the run: over 7 days a transient 429 or blip is
      // likely, and the next hourly pass would have recovered. Failures are
      // recorded and retried instead.
      rec.checks += 1;
      try {
        await runCheck(rec, apiKey, doneSet);
        consecutiveFailures = 0;
        hadSuccess = true;
      } catch (err) {
        if (err instanceof Aborted || m.aborted) throw err;
        consecutiveFailures += 1;
        pushError(
          rec,
          `Check ${rec.checks} failed: ${msg(err)}${hadSuccess ? " — retrying next hour." : ""}`
        );
        // Failing on the very first check usually means a bad key or workspace,
        // and someone is probably watching — surface that immediately rather
        // than silently retrying for a week.
        if (!hadSuccess) {
          rec.status = "error";
          break;
        }
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          pushError(
            rec,
            `Stopped after ${consecutiveFailures} consecutive failed checks — this looks permanent rather than transient.`
          );
          rec.status = "error";
          break;
        }
      }
      rec.lastCheckAt = Date.now();
      rec.updatedAt = Date.now();
      await persist(id);

      if (doneSet.size >= rec.rows.length) break; // everything warming
      if (Date.now() >= rec.deadlineAt) {
        pushError(
          rec,
          `Stopped after 7 days with ${rec.missing.length} inbox(es) never seen in Plusvibe. They're listed below for troubleshooting.`
        );
        break;
      }

      const wait = Math.min(
        CHECK_INTERVAL_MS,
        Math.max(0, rec.deadlineAt - Date.now())
      );
      rec.nextCheckAt = Date.now() + wait;
      await persist(id);

      // Sleep in short slices so an abort is noticed promptly.
      const until = Date.now() + wait;
      while (Date.now() < until) {
        if (m.aborted) throw new Aborted();
        await sleep(Math.min(30_000, until - Date.now()));
      }
    }

    if (rec.status === "running") rec.status = "done";
  } catch (err) {
    if (err instanceof Aborted || m.aborted) rec.status = "aborted";
    else {
      pushError(rec, msg(err));
      rec.status = "error";
    }
  } finally {
    rec.phase = "finished";
    rec.nextCheckAt = undefined;
    rec.updatedAt = Date.now();
    m.apiKey = undefined;
    m.running = false;
    await persist(id);
  }
}

class Aborted extends Error {}

// --- Sheet phase -----------------------------------------------------------

async function updateDomainsSheet(rec: StoredJob) {
  const sheetId = extractSheetId(rec.sheetUrl);
  if (!sheetId) throw new Error("Could not read the spreadsheet ID from the URL.");

  const grid = await readTab(sheetId, rec.sheetTab);
  if (grid.length === 0) throw new Error(`The "${rec.sheetTab}" tab is empty.`);

  const header = grid[0].map((h) => h.trim().toLowerCase());
  const iDomain = header.indexOf(COL_DOMAIN.toLowerCase());
  const iTenant = header.indexOf(COL_TENANT_EMAIL.toLowerCase());
  const iStatus = header.indexOf(COL_STATUS.toLowerCase());
  const missingCols = [
    iDomain === -1 ? COL_DOMAIN : null,
    iTenant === -1 ? COL_TENANT_EMAIL : null,
    iStatus === -1 ? COL_STATUS : null,
  ].filter(Boolean);
  if (missingCols.length > 0) {
    throw new Error(
      `The "${rec.sheetTab}" tab has no ${missingCols.join(", ")} column (found: ${grid[0]
        .map((h) => h.trim())
        .filter(Boolean)
        .join(", ")}).`
    );
  }

  // domain (normalized) -> 1-based sheet row
  const rowByDomain = new Map<string, number>();
  for (let r = 1; r < grid.length; r++) {
    const d = (grid[r][iDomain] ?? "").trim().toLowerCase();
    if (d && !rowByDomain.has(d)) rowByDomain.set(d, r + 1);
  }

  const updates: CellUpdate[] = [];
  const notFound: string[] = [];
  const tab = quoteTab(rec.sheetTab);
  for (const d of rec.domains) {
    const rowNo = rowByDomain.get(d.domain);
    if (!rowNo) {
      notFound.push(d.domain);
      d.sheetNote = "no matching row in the sheet";
      continue;
    }
    updates.push({
      range: `${tab}!${columnLetter(iTenant)}${rowNo}`,
      value: d.orderEmail,
    });
    updates.push({
      range: `${tab}!${columnLetter(iStatus)}${rowNo}`,
      value: STATUS_WARMING_UP,
    });
    d.sheetUpdated = true;
  }

  const cells = await batchUpdateCells(sheetId, updates);
  rec.sheet.rowsUpdated = updates.length / 2;
  rec.sheet.notFound = notFound;
  if (notFound.length > 0) {
    pushError(
      rec,
      `${notFound.length} domain(s) from the upload had no row in the "${rec.sheetTab}" tab: ${notFound.slice(0, 10).join(", ")}${notFound.length > 10 ? " …" : ""}`
    );
  }
  void cells;
}

// --- Polling phase ---------------------------------------------------------

interface AccountLite {
  id: string;
  email: string;
}

/** Every inbox in the workspace, keyed by lowercased email. */
async function fetchWorkspaceInboxes(
  apiKey: string,
  workspace_id: string
): Promise<Map<string, AccountLite>> {
  const out = new Map<string, AccountLite>();
  for (let page = 0; page < ACCOUNTS_MAX_PAGES; page++) {
    await acquireSlot();
    const data = await plusvibeGet<{ accounts?: Record<string, unknown>[] }>({
      apiKey,
      path: "/account/list",
      query: {
        workspace_id,
        skip: String(page * ACCOUNTS_PAGE),
        limit: String(ACCOUNTS_PAGE),
      },
    });
    const batch = Array.isArray(data?.accounts) ? data.accounts : [];
    for (const a of batch) {
      const email = String(a.email ?? "").trim().toLowerCase();
      const accId = String(a.id ?? a._id ?? "");
      if (email && accId) out.set(email, { id: accId, email });
    }
    if (batch.length < ACCOUNTS_PAGE) break;
  }
  return out;
}

/**
 * One hourly pass: list the workspace, find uploaded inboxes that have appeared
 * since last time, apply the warmup settings and switch warmup on. Anything
 * that fails is left out of `doneSet` so the next pass retries it.
 */
async function runCheck(rec: StoredJob, apiKey: string, doneSet: Set<string>) {
  const inboxes = await fetchWorkspaceInboxes(apiKey, rec.workspaceId);

  // Present in Plusvibe but not yet configured.
  const pending: { email: string; id: string; domain: string }[] = [];
  for (const row of rec.rows) {
    if (doneSet.has(row.email)) continue;
    const acc = inboxes.get(row.email);
    if (acc) pending.push({ email: row.email, id: acc.id, domain: row.domain });
  }

  for (let i = 0; i < pending.length; i += BULK_CHUNK) {
    if (Date.now() >= rec.deadlineAt) break;
    const chunk = pending.slice(i, i + BULK_CHUNK);
    const ids = chunk.map((c) => c.id);
    try {
      await acquireSlot();
      await plusvibePut<unknown>({
        apiKey,
        path: "/account/bulk-update",
        body: { workspace_id: rec.workspaceId, ids, ...WARMUP_SETTINGS },
      });
      await acquireSlot();
      await plusvibePatch<unknown>({
        apiKey,
        path: "/account/bulk-update-warmup",
        body: {
          workspace_id: rec.workspaceId,
          ids,
          warmup_status: "ACTIVE",
        },
      });
      for (const c of chunk) doneSet.add(c.email);
      rec.done = Array.from(doneSet);
    } catch (err) {
      pushError(
        rec,
        `Warmup setup failed for ${chunk.length} inbox(es) starting ${chunk[0].email}: ${msg(err)}. They stay pending and are retried next check.`
      );
    }
  }

  // Recount from scratch so the figures can't drift across checks.
  const foundBy = new Map<string, number>();
  const warmedBy = new Map<string, number>();
  const missing: string[] = [];
  let found = 0;
  for (const row of rec.rows) {
    const isWarmed = doneSet.has(row.email);
    const isPresent = isWarmed || inboxes.has(row.email);
    if (isPresent) {
      found += 1;
      foundBy.set(row.domain, (foundBy.get(row.domain) ?? 0) + 1);
    } else {
      missing.push(row.email);
    }
    if (isWarmed) {
      warmedBy.set(row.domain, (warmedBy.get(row.domain) ?? 0) + 1);
    }
  }
  for (const d of rec.domains) {
    d.found = foundBy.get(d.domain) ?? 0;
    d.warmed = warmedBy.get(d.domain) ?? 0;
  }
  rec.totals.found = found;
  rec.totals.warmed = doneSet.size;
  rec.missing = missing;
}

function pushError(rec: StoredJob, text: string) {
  if (rec.errors.length < MAX_STORED_ERRORS) rec.errors.push(text);
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

// --- Query / control -------------------------------------------------------

export async function getJob(
  apiKey: string,
  id: string
): Promise<AzureWarmupJob | null> {
  await loadOnce();
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m || m.fingerprint !== fingerprintKey(apiKey)) return null;
  return toClient(rec);
}

export async function listJobs(apiKey: string): Promise<AzureWarmupJob[]> {
  await loadOnce();
  const fp = fingerprintKey(apiKey);
  const out: AzureWarmupJob[] = [];
  for (const [id, m] of meta) {
    if (m.fingerprint !== fp) continue;
    const rec = records.get(id);
    if (rec) out.push(toClient(rec));
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

export async function abortJob(apiKey: string, id: string): Promise<boolean> {
  await loadOnce();
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m || m.fingerprint !== fingerprintKey(apiKey)) return false;
  m.aborted = true;
  return true;
}
