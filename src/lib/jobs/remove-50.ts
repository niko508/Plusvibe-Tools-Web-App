import "server-only";

import { createHash, randomUUID } from "crypto";
import { promises as fs, mkdirSync, writeFileSync } from "fs";
import path from "path";
import {
  plusvibePost,
  plusvibePut,
  plusvibePatch,
  PlusvibeError,
} from "@/lib/plusvibe-server";
import { acquireSlot } from "@/lib/jobs/rate-limit";
import { onShutdownFlush } from "@/lib/jobs/shutdown";
import type {
  Remove50DomainPlan,
  Remove50DomainRow,
  Remove50Job,
  Remove50JobError,
  Remove50StartPayload,
  WarmupSettings,
} from "@/lib/jobs/remove-50-types";
import { MAX_STORED_ERRORS } from "@/lib/jobs/remove-50-types";

// Server-side manager for "Remove 50 Inboxes from Domain" background jobs. Runs
// in the Node process (surviving the browser tab closing) and persists to disk
// so results can be viewed again on return. The API key and the concrete
// email/id lists + warmup settings are held in memory only and never written to
// disk. Every Plusvibe call passes through the shared global rate limiter
// (one account = one 5 req/s budget).

// JOBS_DIR is the shared base directory (point it at a persistent volume in
// production). Each tool gets its own subdirectory so their records never mix.
const JOBS_BASE = process.env.JOBS_DIR || path.join(process.cwd(), ".jobs-data");
const JOBS_DIR = path.join(JOBS_BASE, "remove-50");
const DELETE_WORKERS = 4;
const CONFIG_WORKERS = 3;
const PERSIST_EVERY = 15; // flush to disk every N completed units

// --- In-memory state -------------------------------------------------------

interface JobMeta {
  fingerprint: string;
  apiKey?: string; // memory-only; absent for jobs loaded from disk
  workspaceId?: string; // memory-only
  settings?: WarmupSettings; // memory-only
  plan?: Remove50DomainPlan[]; // memory-only (delete emails + keep ids)
  aborted: boolean;
  domainIndex: Map<string, Remove50DomainRow>;
}

const records = new Map<string, Remove50Job>();
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
// being torn down (SIGTERM on a redeploy), so a killed job shows up with its
// last-known progress instead of vanishing.
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
    rec.phase = "finished";
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
        const parsed = JSON.parse(raw) as Remove50Job & { fingerprint?: string };
        const fingerprint = parsed.fingerprint ?? "";
        delete (parsed as { fingerprint?: string }).fingerprint;
        if (parsed.status === "running") {
          parsed.status = "interrupted";
          parsed.phase = "finished";
          parsed.updatedAt = parsed.updatedAt || Date.now();
        }
        records.set(parsed.id, parsed);
        meta.set(parsed.id, {
          fingerprint,
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

// --- Job creation ----------------------------------------------------------

export async function createJob(
  apiKey: string,
  payload: Remove50StartPayload
): Promise<string> {
  await loadOnce();

  const id = randomUUID();
  const now = Date.now();
  const fingerprint = fingerprintKey(apiKey);

  const domainIndex = new Map<string, Remove50DomainRow>();
  let inboxesToDelete = 0;
  for (const d of payload.domains) {
    inboxesToDelete += d.deleteEmails.length;
    domainIndex.set(d.domain, {
      domain: d.domain,
      total: d.total,
      toDelete: d.deleteEmails.length,
      keep: d.keepIds.length,
      deleted: 0,
      deleteErrors: 0,
      configured: false,
      warmupEnabled: false,
      businessTypeSkipped: false,
      status: "pending",
    });
  }

  const record: Remove50Job = {
    id,
    label: payload.label || `${payload.domains.length} domains → ${payload.target}`,
    status: "running",
    createdAt: now,
    updatedAt: now,
    workspaceName: payload.workspaceName,
    target: payload.target,
    phase: "deleting",
    progress: {
      domainsTotal: domainIndex.size,
      domainsDone: 0,
      inboxesToDelete,
      inboxesDeleted: 0,
      inboxesSkipped: 0,
      inboxesErrored: 0,
      domainsConfigured: 0,
    },
    domains: Array.from(domainIndex.values()),
    businessTypeSkipped: 0,
    errors: [],
  };

  records.set(id, record);
  meta.set(id, {
    fingerprint,
    apiKey,
    workspaceId: payload.workspaceId,
    settings: payload.settings,
    plan: payload.domains,
    aborted: false,
    domainIndex,
  });

  await persist(id);
  void runJob(id);
  return id;
}

// --- Runner ----------------------------------------------------------------

async function runJob(id: string) {
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m || !m.apiKey || !m.plan || !m.workspaceId || !m.settings) return;

  const apiKey = m.apiKey;
  const workspaceId = m.workspaceId;
  const settings = m.settings;
  const plan = m.plan;
  let sinceFlush = 0;

  const flushMaybe = () => {
    if (++sinceFlush >= PERSIST_EVERY) {
      sinceFlush = 0;
      void persist(id);
    }
  };

  try {
    // --- Phase 1: delete the worst inboxes across all trimmed domains ------
    rec.phase = "deleting";
    const deleteTasks: { domain: string; email: string }[] = [];
    for (const d of plan) {
      for (const email of d.deleteEmails) {
        deleteTasks.push({ domain: d.domain, email });
      }
    }

    let dCursor = 0;
    const deleteWorker = async () => {
      while (true) {
        if (m.aborted) return;
        const i = dCursor++;
        if (i >= deleteTasks.length) return;
        const task = deleteTasks[i];
        const row = m.domainIndex.get(task.domain);
        if (row && row.status === "pending") row.status = "deleting";

        await acquireSlot();
        if (m.aborted) return;

        try {
          await plusvibePost({
            apiKey,
            path: "/account/delete",
            body: { workspace_id: workspaceId, email: task.email },
          });
          rec.progress.inboxesDeleted += 1;
          if (row) row.deleted += 1;
        } catch (err) {
          if (isAlreadyGone(err)) {
            rec.progress.inboxesSkipped += 1;
            if (row) row.deleted += 1; // already gone == trimmed
          } else {
            rec.progress.inboxesErrored += 1;
            if (row) row.deleteErrors += 1;
            pushError(rec, {
              domain: task.domain,
              email: task.email,
              phase: "delete",
              reason: err instanceof Error ? err.message : "Unknown error",
            });
          }
        }
        rec.updatedAt = Date.now();
        flushMaybe();
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(DELETE_WORKERS, deleteTasks.length) }, () =>
        deleteWorker()
      )
    );

    // --- Phase 2: apply warmup settings + enable warmup on kept inboxes -----
    if (!m.aborted) {
      rec.phase = "configuring";
      const domains = plan.filter((d) => d.keepIds.length > 0);
      let cCursor = 0;
      const configWorker = async () => {
        while (true) {
          if (m.aborted) return;
          const i = cCursor++;
          if (i >= domains.length) return;
          const d = domains[i];
          const row = m.domainIndex.get(d.domain);
          if (row) row.status = "configuring";

          try {
            // Apply warmup settings (with business-type fallback).
            const skipped = await applyWarmup(apiKey, workspaceId, d.keepIds, settings);
            if (row) {
              row.configured = true;
              row.businessTypeSkipped = skipped;
            }
            if (skipped) rec.businessTypeSkipped += 1;

            // Enable warmup.
            await acquireSlot();
            if (m.aborted) return;
            await plusvibePatch({
              apiKey,
              path: "/account/bulk-update-warmup",
              body: { workspace_id: workspaceId, ids: d.keepIds, warmup_status: "ACTIVE" },
            });
            if (row) row.warmupEnabled = true;
            rec.progress.domainsConfigured += 1;
          } catch (err) {
            pushError(rec, {
              domain: d.domain,
              phase: "configure",
              reason: err instanceof Error ? err.message : "Unknown error",
            });
            if (row) row.error = err instanceof Error ? err.message : "Unknown error";
          }
          if (row) finalizeDomain(rec, row);
          rec.updatedAt = Date.now();
          flushMaybe();
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(CONFIG_WORKERS, domains.length) }, () =>
          configWorker()
        )
      );
    }

    // Domains with nothing to configure still need a final status.
    for (const row of m.domainIndex.values()) {
      if (row.status === "pending" || row.status === "deleting" || row.status === "configuring") {
        finalizeDomain(rec, row);
      }
    }

    rec.status = m.aborted ? "aborted" : "done";
    rec.phase = "finished";
  } catch {
    rec.status = "error";
    rec.phase = "finished";
  } finally {
    rec.updatedAt = Date.now();
    // Drop memory-only fields now the run is over.
    m.apiKey = undefined;
    m.plan = undefined;
    m.settings = undefined;
    m.workspaceId = undefined;
    await persist(id);
  }
}

// Applies the warmup settings; if the API rejects the business type, retries
// once without it so the rest still applies. Returns whether it was skipped.
async function applyWarmup(
  apiKey: string,
  workspaceId: string,
  ids: string[],
  settings: WarmupSettings
): Promise<boolean> {
  await acquireSlot();
  try {
    await plusvibePut({
      apiKey,
      path: "/account/bulk-update",
      body: { workspace_id: workspaceId, ids, ...settings },
    });
    return false;
  } catch (err) {
    if (settings.warmup_business_type === undefined) throw err;
    // Retry without the (possibly-unsupported) business type.
    const { warmup_business_type, ...rest } = settings;
    void warmup_business_type;
    await acquireSlot();
    await plusvibePut({
      apiKey,
      path: "/account/bulk-update",
      body: { workspace_id: workspaceId, ids, ...rest },
    });
    return true;
  }
}

function finalizeDomain(rec: Remove50Job, row: Remove50DomainRow) {
  if (row.status === "done" || row.status === "partial" || row.status === "error") {
    return; // already finalized
  }
  const deleteOk = row.deleteErrors === 0;
  const configOk = row.keep === 0 || (row.configured && row.warmupEnabled);
  if (deleteOk && configOk) {
    row.status = "done";
  } else if (row.deleted > 0 || row.configured || row.warmupEnabled) {
    row.status = "partial";
  } else {
    row.status = "error";
  }
  rec.progress.domainsDone += 1;
}

function pushError(rec: Remove50Job, err: Remove50JobError) {
  if (rec.errors.length < MAX_STORED_ERRORS) {
    rec.errors.push(err);
  } else {
    rec.errorsTruncated = true;
  }
}

function isAlreadyGone(err: unknown): boolean {
  if (err instanceof PlusvibeError) {
    if (err.status === 404) return true;
    return /not\s*found|does\s*not\s*exist|no\s*such/i.test(err.message);
  }
  return false;
}

// --- Query / control (all scoped by API key fingerprint) -------------------

export async function getJob(
  apiKey: string,
  id: string
): Promise<Remove50Job | null> {
  await loadOnce();
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m) return null;
  if (m.fingerprint !== fingerprintKey(apiKey)) return null;
  return rec;
}

export async function listJobs(apiKey: string): Promise<Remove50Job[]> {
  await loadOnce();
  const fp = fingerprintKey(apiKey);
  const out: Remove50Job[] = [];
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
