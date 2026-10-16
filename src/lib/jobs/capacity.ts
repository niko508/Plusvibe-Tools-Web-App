import "server-only";

import { createHash, randomUUID } from "crypto";
import { promises as fs, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { onShutdownFlush } from "@/lib/jobs/shutdown";
import { listInboxes, listWorkspaces } from "@/lib/blocked-domains/api";
import {
  capacityOf,
  isExcluded,
  sortRows,
  totalsOf,
  type WorkspaceCapacity,
} from "@/lib/capacity/capacity";
import type { CapacityJob } from "@/lib/jobs/capacity-types";
import { MAX_STORED_ERRORS } from "@/lib/jobs/capacity-types";

// Server-side manager for Sending Capacity.
//
// Reads only: every workspace's inboxes, counted by what they run on. It is a
// background job for the same reason the burned scan is — a couple of dozen
// workspaces at 5 requests a second takes long enough that a closed tab must
// not lose it.
//
// ONE RUN AT A TIME per API key: a second would only compete with the first
// for the same budget and take twice as long to say the same thing.

const JOBS_BASE = process.env.JOBS_DIR || path.join(process.cwd(), ".jobs-data");
const JOBS_DIR = path.join(JOBS_BASE, "capacity");
/** Only the newest few are worth keeping: this is a snapshot, not a ledger. */
const KEEP = 10;

interface JobMeta {
  fingerprint: string;
  apiKey?: string;
  aborted: boolean;
}

const records = new Map<string, CapacityJob>();
const meta = new Map<string, JobMeta>();
let loaded = false;

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
    await fs.writeFile(fileFor(id), JSON.stringify({ ...rec, fingerprint: m.fingerprint }), "utf8");
  } catch {
    // best-effort; a failed write must not kill the run
  }
}

const live = (r: CapacityJob) => r.status === "running";

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
      if (!f.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(JOBS_DIR, f), "utf8")) as CapacityJob & {
          fingerprint?: string;
        };
        const fingerprint = parsed.fingerprint ?? "";
        delete (parsed as { fingerprint?: string }).fingerprint;
        if (live(parsed)) parsed.status = "interrupted";
        parsed.rows = Array.isArray(parsed.rows) ? parsed.rows : [];
        parsed.excluded = Array.isArray(parsed.excluded) ? parsed.excluded : [];
        parsed.errors = Array.isArray(parsed.errors) ? parsed.errors : [];
        parsed.totals = parsed.totals ?? totalsOf(parsed.rows);
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
    super("A refresh is already running — let it finish or stop it first.");
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

export async function createJob(apiKey: string): Promise<string> {
  await loadOnce();
  const fp = fingerprintKey(apiKey);
  const running = activeIdFor(fp);
  if (running) throw new ActiveJobError(running);

  const id = randomUUID();
  const now = Date.now();
  const record: CapacityJob = {
    id,
    status: "running",
    createdAt: now,
    updatedAt: now,
    rows: [],
    totals: totalsOf([]),
    excluded: [],
    progress: { done: 0, total: 0, inboxes: 0 },
    errors: [],
  };
  records.set(id, record);
  meta.set(id, { fingerprint: fp, apiKey, aborted: false });
  await persist(id);
  void runJob(id);
  await prune(fp);
  return id;
}

/** Keeps the newest few snapshots per key; the rest are just old numbers. */
async function prune(fp: string) {
  const mine = [...meta.entries()]
    .filter(([, m]) => m.fingerprint === fp)
    .map(([id]) => records.get(id))
    .filter((r): r is CapacityJob => !!r && !live(r))
    .sort((a, b) => b.createdAt - a.createdAt);
  for (const rec of mine.slice(KEEP)) {
    records.delete(rec.id);
    meta.delete(rec.id);
    try {
      await fs.unlink(fileFor(rec.id));
    } catch {
      // already gone
    }
  }
}

// --- The run ---------------------------------------------------------------

class AbortedError extends Error {}

const msg = (err: unknown) => (err instanceof Error ? err.message : "Unknown error");

function pushError(rec: CapacityJob, text: string) {
  if (rec.errors.length < MAX_STORED_ERRORS) rec.errors.push(text);
  else rec.errorsTruncated = true;
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
      pushError(rec, `Could not list the workspaces: ${msg(err)}. Nothing was counted.`);
      rec.status = "error";
      return;
    }

    // The two that never send to prospects are dropped by name before any
    // inbox is read, and named so their absence is not a mystery.
    const counting = workspaces.filter((w) => !isExcluded(w.name));
    rec.excluded = workspaces.filter((w) => isExcluded(w.name)).map((w) => w.name);
    rec.progress.total = counting.length;
    await touch();

    const rows: WorkspaceCapacity[] = [];
    for (const w of counting) {
      check();
      try {
        const inboxes = await listInboxes(apiKey, w._id);
        rows.push(capacityOf({ workspaceId: w._id, workspaceName: w.name }, inboxes));
        rec.progress.inboxes += inboxes.length;
      } catch (err) {
        // One workspace that cannot be read must not cost the other twenty-six:
        // it is reported and left out, and the total says so.
        pushError(rec, `${w.name}: could not read its inboxes (${msg(err)}), so it is not counted.`);
      }
      rec.progress.done += 1;
      // Sorted as it goes, so a long run is useful before it ends.
      rec.rows = sortRows(rows);
      rec.totals = totalsOf(rows);
      await touch();
    }

    rec.status = rec.errors.length > 0 ? "error" : "done";
  } catch (err) {
    if (err instanceof AbortedError || m.aborted) rec.status = "aborted";
    else {
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

export async function listJobs(apiKey: string): Promise<CapacityJob[]> {
  await loadOnce();
  const fp = fingerprintKey(apiKey);
  const out: CapacityJob[] = [];
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
