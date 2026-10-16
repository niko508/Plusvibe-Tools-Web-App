import "server-only";

import { createHash, randomUUID } from "crypto";
import { promises as fs, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { plusvibePost, PlusvibeError } from "@/lib/plusvibe-server";
import { acquireSlot } from "@/lib/jobs/rate-limit";
import { onShutdownFlush } from "@/lib/jobs/shutdown";
import type {
  DeleteTask,
  JobDomainRow,
  JobError,
  JobRecord,
  StartJobPayload,
} from "@/lib/jobs/types";
import { MAX_STORED_ERRORS } from "@/lib/jobs/types";

// Server-side manager for "Remove Inboxes" background jobs. Jobs run in the
// Node process (surviving the browser tab closing) and are persisted to disk so
// results can be viewed again on return. The Plusvibe API key is held in memory
// only and never written to disk. Deletions across ALL jobs (and other tools)
// share one global rate limiter, because a Plusvibe account has a single
// 5 req/s budget.

// JOBS_DIR is the shared base directory (point it at a persistent volume in
// production). Each tool gets its own subdirectory so their records never mix.
const JOBS_BASE = process.env.JOBS_DIR || path.join(process.cwd(), ".jobs-data");
const JOBS_DIR = path.join(JOBS_BASE, "bulk-delete");
const WORKERS_PER_JOB = 4;
const PERSIST_EVERY = 20; // flush to disk every N completed inboxes

// --- In-memory state -------------------------------------------------------

interface JobMeta {
  fingerprint: string;
  apiKey?: string; // memory-only; absent for jobs loaded from disk
  tasks?: DeleteTask[]; // memory-only
  workspaceNames: Record<string, string>;
  aborted: boolean;
  domainIndex: Map<string, JobDomainRow>;
}

const records = new Map<string, JobRecord>();
const meta = new Map<string, JobMeta>();

let loaded = false;

// --- Persistence -----------------------------------------------------------

function fingerprintKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

async function ensureDir() {
  await fs.mkdir(JOBS_DIR, { recursive: true });
}

function fileFor(id: string) {
  return path.join(JOBS_DIR, `${id}.json`);
}

async function persist(id: string) {
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m) return;
  try {
    await ensureDir();
    await fs.writeFile(
      fileFor(id),
      JSON.stringify({ ...rec, fingerprint: m.fingerprint }),
      "utf8"
    );
  } catch {
    // Persistence is best-effort; a failed write must not kill the run.
  }
}

// Synchronously persist any running jobs as "interrupted" when the process is
// being torn down (SIGTERM on a redeploy). writeFileSync guarantees the flush
// completes inside the signal handler, before the container is killed.
function flushRunningSync() {
  let any = false;
  for (const [, rec] of records) {
    if (rec.status === "running") {
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
    if (rec.status !== "running") continue;
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

// Loads persisted jobs once per process. Any job left "running" belonged to a
// previous process (its in-memory runner is gone), so it's marked interrupted.
async function loadOnce() {
  if (loaded) return;
  loaded = true;
  try {
    await ensureDir();
    const files = await fs.readdir(JOBS_DIR);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(JOBS_DIR, f), "utf8");
        const parsed = JSON.parse(raw) as JobRecord & { fingerprint?: string };
        const fingerprint = parsed.fingerprint ?? "";
        delete (parsed as { fingerprint?: string }).fingerprint;
        if (parsed.status === "running") {
          parsed.status = "interrupted";
          parsed.updatedAt = parsed.updatedAt || Date.now();
        }
        records.set(parsed.id, parsed);
        meta.set(parsed.id, {
          fingerprint,
          workspaceNames: {},
          aborted: false,
          domainIndex: new Map(),
        });
      } catch {
        // skip unreadable/corrupt record
      }
    }
  } catch {
    // no dir yet / unreadable — nothing to load
  }
}

// --- Job creation + runner -------------------------------------------------

export async function createJob(
  apiKey: string,
  payload: StartJobPayload
): Promise<string> {
  await loadOnce();

  const id = randomUUID();
  const now = Date.now();
  const fingerprint = fingerprintKey(apiKey);

  // Build per-domain rollups from the task list.
  const domainIndex = new Map<string, JobDomainRow>();
  for (const t of payload.tasks) {
    let row = domainIndex.get(t.domain);
    if (!row) {
      row = {
        domain: t.domain,
        total: 0,
        deleted: 0,
        skipped: 0,
        errors: 0,
        status: "pending",
      };
      domainIndex.set(t.domain, row);
    }
    row.total += 1;
  }

  const record: JobRecord = {
    id,
    label: payload.label || `${payload.tasks.length} inboxes`,
    status: "running",
    createdAt: now,
    updatedAt: now,
    scopeWorkspaces: Object.values(payload.workspaceNames),
    progress: {
      domainsTotal: domainIndex.size,
      domainsDone: 0,
      inboxesTotal: payload.tasks.length,
      inboxesAttempted: 0,
      inboxesDeleted: 0,
      inboxesSkipped: 0,
      inboxesErrored: 0,
    },
    domains: Array.from(domainIndex.values()),
    notFound: payload.notFound ?? [],
    mode: payload.mode === "inbox" ? "inbox" : "domain",
    errors: [],
  };

  records.set(id, record);
  meta.set(id, {
    fingerprint,
    apiKey,
    tasks: payload.tasks,
    workspaceNames: payload.workspaceNames,
    aborted: false,
    domainIndex,
  });

  await persist(id);
  // Fire and forget — the runner drives the job in the background.
  void runJob(id);
  return id;
}

async function runJob(id: string) {
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m || !m.apiKey || !m.tasks) return;

  const tasks = m.tasks;
  let cursor = 0;
  let sinceFlush = 0;

  const worker = async () => {
    while (true) {
      if (m.aborted) return;
      const i = cursor++;
      if (i >= tasks.length) return;
      const task = tasks[i];

      await acquireSlot();
      if (m.aborted) return;

      const row = m.domainIndex.get(task.domain);
      if (row) row.status = "running";

      try {
        await plusvibePost({
          apiKey: m.apiKey!,
          path: "/account/delete",
          body: { workspace_id: task.workspace_id, email: task.email },
        });
        rec.progress.inboxesDeleted += 1;
        if (row) row.deleted += 1;
      } catch (err) {
        if (isAlreadyGone(err)) {
          // Inbox no longer exists — treat as done (keeps re-runs clean).
          rec.progress.inboxesSkipped += 1;
          if (row) row.skipped += 1;
        } else {
          rec.progress.inboxesErrored += 1;
          if (row) row.errors += 1;
          if (rec.errors.length < MAX_STORED_ERRORS) {
            rec.errors.push(errorFor(task, m, err));
          } else {
            rec.errorsTruncated = true;
          }
        }
      }

      rec.progress.inboxesAttempted += 1;
      if (row) finalizeDomain(rec, row);
      rec.updatedAt = Date.now();

      if (++sinceFlush >= PERSIST_EVERY) {
        sinceFlush = 0;
        void persist(id);
      }
    }
  };

  try {
    await Promise.all(
      Array.from({ length: Math.min(WORKERS_PER_JOB, tasks.length) }, () =>
        worker()
      )
    );
    rec.status = m.aborted ? "aborted" : "done";
  } catch {
    rec.status = "error";
  } finally {
    rec.updatedAt = Date.now();
    // Drop memory-only fields now the run is over.
    m.apiKey = undefined;
    m.tasks = undefined;
    await persist(id);
  }
}

function finalizeDomain(rec: JobRecord, row: JobDomainRow) {
  const handled = row.deleted + row.skipped + row.errors;
  if (handled >= row.total) {
    const prev = row.status;
    row.status = row.errors > 0 ? (row.deleted + row.skipped > 0 ? "partial" : "error") : "done";
    if (prev !== "done" && prev !== "partial" && prev !== "error") {
      rec.progress.domainsDone += 1;
    }
  }
}

function isAlreadyGone(err: unknown): boolean {
  if (err instanceof PlusvibeError) {
    if (err.status === 404) return true;
    return /not\s*found|does\s*not\s*exist|no\s*such/i.test(err.message);
  }
  return false;
}

function errorFor(task: DeleteTask, m: JobMeta, err: unknown): JobError {
  return {
    workspace_id: task.workspace_id,
    workspaceName: m.workspaceNames[task.workspace_id],
    email: task.email,
    reason: err instanceof Error ? err.message : "Unknown error",
  };
}

// --- Query / control (all scoped by API key fingerprint) -------------------

export async function getJob(
  apiKey: string,
  id: string
): Promise<JobRecord | null> {
  await loadOnce();
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m) return null;
  if (m.fingerprint !== fingerprintKey(apiKey)) return null;
  return rec;
}

export async function listJobs(apiKey: string): Promise<JobRecord[]> {
  await loadOnce();
  const fp = fingerprintKey(apiKey);
  const out: JobRecord[] = [];
  for (const [id, m] of meta) {
    if (m.fingerprint !== fp) continue;
    const rec = records.get(id);
    if (rec) out.push(rec);
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

/**
 * Permanently removes a job and its persisted record.
 *
 * A live runner is aborted first: it holds a reference to the same meta object,
 * so flipping `aborted` stops it, and once the record is out of `records` any
 * later persist() from its finally block is a no-op rather than recreating the
 * file we just deleted.
 */
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
    // already gone from disk — nothing to do
  }
  return true;
}

export async function abortJob(apiKey: string, id: string): Promise<boolean> {
  await loadOnce();
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m) return false;
  if (m.fingerprint !== fingerprintKey(apiKey)) return false;
  m.aborted = true;
  return true;
}
