import "server-only";

import { createHash, randomUUID } from "crypto";
import { promises as fs, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { onShutdownFlush } from "@/lib/jobs/shutdown";
import { fetchInboxStats, listInboxes, listWorkspaces, type Inbox } from "@/lib/blocked-domains/api";
import { indexStats } from "@/lib/blocked-domains/performance";
import { bucketOf } from "@/lib/plusvibe-providers";
import { ESP_LABELS, levelOf, normalizeThresholds, type Esp, type Thresholds } from "@/lib/burned/settings";
import { countRows, rowsFor, sortRows, type ScanRow } from "@/lib/burned/scan";
import { thresholdsFor } from "@/lib/burned/store";
import type { BurnedJob, BurnedStartPayload, WorkspaceScan } from "@/lib/jobs/burned-types";
import { MAX_STORED_ERRORS } from "@/lib/jobs/burned-types";

// Server-side manager for Find Burned Domains & Inboxes jobs.
//
// Reads only. Per workspace: every inbox is listed, the ones on the chosen
// provider are kept, their stats for the range are read in bulk (100 at a
// time, falling back to one call per inbox), and the rows are judged against
// the provider's saved thresholds.
//
// Runs in the Node process so the scan survives the tab closing, and persists
// to disk so the results can be read back later. The API key is memory-only.
//
// ONE JOB AT A TIME per API key: a second scan would only compete with the
// first for the same 5 req/s budget and take twice as long to say the same
// thing.

const JOBS_BASE = process.env.JOBS_DIR || path.join(process.cwd(), ".jobs-data");
const JOBS_DIR = path.join(JOBS_BASE, "burned");
/** Enough for every domain and inbox across a large account, with room to spare. */
const MAX_ROWS = 20_000;

interface JobMeta {
  fingerprint: string;
  apiKey?: string;
  aborted: boolean;
}

const records = new Map<string, BurnedJob>();
const meta = new Map<string, JobMeta>();
let loaded = false;

// --- Persistence -----------------------------------------------------------

function fingerprintKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

function fileFor(id: string) {
  return path.join(JOBS_DIR, `${id}.json`);
}

async function persist(id: string) {
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m) return;
  try {
    await fs.mkdir(JOBS_DIR, { recursive: true });
    await fs.writeFile(fileFor(id), JSON.stringify({ ...rec, fingerprint: m.fingerprint }), "utf8");
  } catch {
    // best-effort; a failed write must not kill the run
  }
}

const live = (r: BurnedJob) => r.status === "running";

function flushRunningSync() {
  if (![...records.values()].some(live)) return;
  try {
    mkdirSync(JOBS_DIR, { recursive: true });
  } catch {
    return;
  }
  for (const [id, rec] of records) {
    if (!live(rec)) continue;
    const m = meta.get(id);
    if (!m) continue;
    rec.status = "interrupted";
    rec.updatedAt = Date.now();
    try {
      writeFileSync(fileFor(id), JSON.stringify({ ...rec, fingerprint: m.fingerprint }), "utf8");
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
      if (!f.endsWith(".json") || f === "settings.json") continue;
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(JOBS_DIR, f), "utf8")) as BurnedJob & { fingerprint?: string };
        const fingerprint = parsed.fingerprint ?? "";
        delete (parsed as { fingerprint?: string }).fingerprint;
        if (live(parsed)) parsed.status = "interrupted";
        // Everything the UI iterates, defaulted, so a record from any past or
        // future shape still lists rather than blanking the page.
        parsed.workspaces = Array.isArray(parsed.workspaces) ? parsed.workspaces : [];
        parsed.rows = Array.isArray(parsed.rows) ? parsed.rows : [];
        parsed.errors = Array.isArray(parsed.errors) ? parsed.errors : [];
        // A record written before the Reply % rescue has no bar for it; the
        // card would otherwise read "under undefined%".
        parsed.thresholds = normalizeThresholds(parsed.thresholds, parsed.esp === "google" ? "google" : "microsoft");
        records.set(parsed.id, parsed);
        meta.set(parsed.id, { fingerprint, aborted: false });
      } catch {
        // skip corrupt record
      }
    }
  } catch {
    // nothing to load
  }
}

// --- Creation --------------------------------------------------------------

export class ActiveJobError extends Error {
  constructor(readonly activeJobId: string) {
    super("A scan is already running — let it finish or stop it first.");
    this.name = "ActiveJobError";
  }
}

function activeIdFor(fp: string): string | null {
  for (const [id, m] of meta) {
    if (m.fingerprint !== fp) continue;
    const r = records.get(id);
    if (r && live(r)) return id;
  }
  return null;
}

const emptyCounts = () => ({ scanned: 0, burned: 0, ok: 0, rescued: 0, fewSends: 0, noFigures: 0 });

export async function createJob(apiKey: string, payload: BurnedStartPayload): Promise<string> {
  await loadOnce();
  const fp = fingerprintKey(apiKey);
  const running = activeIdFor(fp);
  if (running) throw new ActiveJobError(running);

  // Taken now rather than when each workspace is reached: what the thresholds
  // said when Scan was pressed is what the whole run uses, and the record
  // keeps them so a result can always be read against the bar that made it.
  const thresholds = await thresholdsFor(payload.esp);

  const id = randomUUID();
  const now = Date.now();
  const record: BurnedJob = {
    id,
    label: `${ESP_LABELS[payload.esp]} ${levelOf(payload.esp) === "inbox" ? "inboxes" : "domains"} · ${payload.start} → ${payload.end}`,
    status: "running",
    createdAt: now,
    updatedAt: now,
    esp: payload.esp,
    thresholds,
    start: payload.start,
    end: payload.end,
    workspaces: [],
    rows: [],
    progress: { workspacesDone: 0, workspacesTotal: 0, inboxesRead: 0, scanned: 0, burned: 0 },
    errors: [],
  };
  records.set(id, record);
  meta.set(id, { fingerprint: fp, apiKey, aborted: false });
  await persist(id);
  void runJob(id);
  return id;
}

// --- The run ---------------------------------------------------------------

class AbortedError extends Error {}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

function pushError(rec: BurnedJob, text: string) {
  if (rec.errors.length < MAX_STORED_ERRORS) rec.errors.push(text);
  else rec.errorsTruncated = true;
}

/** The inboxes on the provider being scanned. */
function onEsp(inboxes: Inbox[], esp: Esp): Inbox[] {
  return inboxes.filter((i) => bucketOf(i.provider) === esp);
}

async function scanWorkspace(
  apiKey: string,
  ws: WorkspaceScan,
  rec: BurnedJob,
  thresholds: Thresholds,
  check: () => void
): Promise<ScanRow[]> {
  check();
  ws.state = "listing";

  let inboxes: Inbox[];
  try {
    inboxes = await listInboxes(apiKey, ws.workspaceId);
  } catch (err) {
    ws.state = "error";
    ws.error = `Could not list the inboxes: ${msg(err)}`;
    pushError(rec, `${ws.workspaceName}: ${ws.error}`);
    return [];
  }

  const mine = onEsp(inboxes, rec.esp);
  ws.inboxes = mine.length;
  rec.progress.inboxesRead += mine.length;
  if (mine.length === 0) {
    ws.state = "done";
    return [];
  }

  check();
  ws.state = "stats";
  const { rows: stats, errors } = await fetchInboxStats(apiKey, ws.workspaceId, mine, {
    start: rec.start,
    end: rec.end,
  });
  // A stats failure is reported and the workspace carries on: the rows it
  // could not read come out as "no figures", which is the honest answer and
  // never names a domain burned on no evidence.
  for (const e of errors) pushError(rec, `${ws.workspaceName}: ${e}`);

  check();
  const rows = rowsFor(rec.esp, { workspaceId: ws.workspaceId, workspaceName: ws.workspaceName }, mine, indexStats(stats), thresholds);
  ws.counts = countRows(rows);
  ws.state = "done";
  return rows;
}

async function runJob(id: string) {
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m || !m.apiKey) return;
  const apiKey = m.apiKey;
  const check = () => {
    if (m.aborted) throw new AbortedError();
  };
  const touch = async () => {
    rec.updatedAt = Date.now();
    await persist(id);
  };

  try {
    let workspaces;
    try {
      workspaces = await listWorkspaces(apiKey);
    } catch (err) {
      pushError(rec, `Could not list the workspaces: ${msg(err)}. Nothing was scanned.`);
      rec.status = "error";
      return;
    }
    rec.workspaces = workspaces.map((w) => ({
      workspaceId: w._id,
      workspaceName: w.name,
      state: "pending" as const,
      inboxes: 0,
      counts: emptyCounts(),
    }));
    rec.progress.workspacesTotal = rec.workspaces.length;
    await touch();

    const all: ScanRow[] = [];
    for (const ws of rec.workspaces) {
      check();
      const rows = await scanWorkspace(apiKey, ws, rec, rec.thresholds, check);
      all.push(...rows);
      rec.progress.workspacesDone += 1;
      rec.progress.scanned += rows.length;
      rec.progress.burned += rows.filter((r) => r.verdict === "burned").length;
      // Burned first as the run goes, so a long scan is useful before it ends.
      rec.rows = sortRows(all).slice(0, MAX_ROWS);
      rec.rowsTruncated = all.length > MAX_ROWS;
      await touch();
    }

    if (rec.rowsTruncated) {
      pushError(rec, `More than ${MAX_ROWS.toLocaleString()} rows were judged; the list keeps the worst ${MAX_ROWS.toLocaleString()}. The counts above cover them all.`);
    }
    rec.status = rec.workspaces.some((w) => w.state === "error") ? "error" : "done";
  } catch (err) {
    if (err instanceof AbortedError || m.aborted) {
      rec.status = "aborted";
    } else {
      pushError(rec, msg(err));
      rec.status = "error";
    }
  } finally {
    rec.finishedAt = Date.now();
    rec.updatedAt = rec.finishedAt;
    m.apiKey = undefined;
    await persist(id);
  }
}

// --- Query / control -------------------------------------------------------

export async function getJob(apiKey: string, id: string): Promise<BurnedJob | null> {
  await loadOnce();
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m || m.fingerprint !== fingerprintKey(apiKey)) return null;
  return rec;
}

export async function listJobs(apiKey: string): Promise<BurnedJob[]> {
  await loadOnce();
  const fp = fingerprintKey(apiKey);
  const out: BurnedJob[] = [];
  for (const [id, m] of meta) {
    if (m.fingerprint !== fp) continue;
    const rec = records.get(id);
    if (rec) out.push(rec);
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

export async function deleteJob(apiKey: string, id: string): Promise<boolean> {
  await loadOnce();
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m || m.fingerprint !== fingerprintKey(apiKey)) return false;
  m.aborted = true;
  records.delete(id);
  meta.delete(id);
  try {
    await fs.unlink(fileFor(id));
  } catch {
    // already gone
  }
  return true;
}
