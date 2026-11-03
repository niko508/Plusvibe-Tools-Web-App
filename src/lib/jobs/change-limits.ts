import "server-only";

import { createHash, randomUUID } from "crypto";
import { promises as fs, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { onShutdownFlush } from "@/lib/jobs/shutdown";
import { acquireSlot } from "@/lib/jobs/rate-limit";
import { plusvibePut } from "@/lib/plusvibe-server";
import {
  bundleBlocks,
  describeBundle,
  parseBundle,
} from "@/lib/change-limits/settings";
import type { ProviderBucket } from "@/lib/plusvibe-providers";
import type {
  ChangeLimitsGroup,
  ChangeLimitsJob,
  ChangeLimitsStartPayload,
} from "@/lib/jobs/change-limits-types";
import { MAX_STORED_ERRORS, UPDATE_CHUNK } from "@/lib/jobs/change-limits-types";

// Server-side manager for Change Limits jobs.
//
// The qualifying inboxes were already worked out in the browser; this applies
// the settings to them, one workspace at a time, in chunks the bulk endpoint
// accepts. Only the fields the user filled in are sent, so nothing else on an
// inbox is touched.
//
// ONE JOB AT A TIME per API key: two runs over the same inboxes would race to
// set the same fields and the second would silently win.

const JOBS_BASE = process.env.JOBS_DIR || path.join(process.cwd(), ".jobs-data");
const JOBS_DIR = path.join(JOBS_BASE, "change-limits");

interface JobMeta {
  fingerprint: string;
  apiKey?: string;
  aborted: boolean;
  /** The update bodies and the inboxes live only in memory while the job runs. */
  bodies?: Record<ProviderBucket, Record<string, string | number>>;
  targets?: ChangeLimitsStartPayload["targets"];
}

const records = new Map<string, ChangeLimitsJob>();
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
    await fs.writeFile(
      fileFor(id),
      JSON.stringify({ ...rec, fingerprint: m.fingerprint }),
      "utf8"
    );
  } catch {
    // best-effort
  }
}

const live = (r: ChangeLimitsJob) => r.status === "running";

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
        const parsed = JSON.parse(
          await fs.readFile(path.join(JOBS_DIR, f), "utf8")
        ) as ChangeLimitsJob & { fingerprint?: string };
        const fingerprint = parsed.fingerprint ?? "";
        delete (parsed as { fingerprint?: string }).fingerprint;
        // The key lived only in memory, so a job caught mid-run can't go on.
        if (live(parsed)) parsed.status = "interrupted";
        parsed.groups = Array.isArray(parsed.groups) ? parsed.groups : [];
        parsed.errors = Array.isArray(parsed.errors) ? parsed.errors : [];
        parsed.settings = normalizeSettings(parsed.settings);
        // Runs from before per-provider settings had no provider on a group.
        for (const g of parsed.groups) {
          if (!g.provider) g.provider = "other";
        }
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

/**
 * Runs recorded before per-provider settings stored a flat list of rows.
 * Those are wrapped into a single "all senders" block so an old job still
 * reads correctly instead of rendering as nothing.
 */
function normalizeSettings(raw: unknown): ChangeLimitsJob["settings"] {
  if (!Array.isArray(raw)) return [];
  if (raw.length === 0) return [];
  const first = raw[0] as Record<string, unknown>;
  if (first && typeof first === "object" && Array.isArray(first.rows)) {
    return raw as ChangeLimitsJob["settings"];
  }
  return [
    {
      scope: "all",
      label: "All senders",
      rows: raw as ChangeLimitsJob["settings"][number]["rows"],
    },
  ];
}

// --- Creation --------------------------------------------------------------

export class ActiveJobError extends Error {
  constructor(readonly activeJobId: string) {
    super("A limits update is already running — let it finish or stop it first.");
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

export async function createJob(
  apiKey: string,
  payload: ChangeLimitsStartPayload
): Promise<string> {
  await loadOnce();
  const fp = fingerprintKey(apiKey);
  const running = activeIdFor(fp);
  if (running) throw new ActiveJobError(running);

  // Re-checked here rather than trusted from the browser: this is the last
  // point before real inboxes change.
  const parsed = parseBundle(payload.settings);
  for (const b of ["google", "microsoft", "other"] as ProviderBucket[]) {
    const firstProblem = Object.values(parsed.byProvider[b].problems)[0];
    if (firstProblem) throw new Error(firstProblem);
  }
  if (!parsed.anyOk) throw new Error("Set at least one value under Increase settings.");

  // A group whose provider has nothing set would send an empty update, so it
  // never reaches the run at all.
  const targets = payload.targets.filter(
    (t) => t.workspaceId && t.inboxes.length > 0 && parsed.byProvider[t.provider]?.ok
  );
  if (targets.length === 0) {
    throw new Error(
      "No inboxes to update: nothing is set for the providers these inboxes send through."
    );
  }

  const inboxesTotal = targets.reduce((n, t) => n + t.inboxes.length, 0);
  const blocks = bundleBlocks(payload.settings);
  const id = randomUUID();
  const now = Date.now();
  const record: ChangeLimitsJob = {
    id,
    label: `${inboxesTotal} inbox${inboxesTotal === 1 ? "" : "es"} · ${describeBundle(blocks)}`,
    status: "running",
    createdAt: now,
    updatedAt: now,
    settings: blocks,
    groups: targets.map((t) => ({
      workspaceId: t.workspaceId,
      workspaceName: t.workspaceName,
      provider: t.provider,
      total: t.inboxes.length,
      updated: 0,
      failed: 0,
      state: "pending" as const,
    })),
    progress: {
      workspacesTotal: targets.length,
      workspacesDone: 0,
      inboxesTotal,
      inboxesUpdated: 0,
      inboxesFailed: 0,
    },
    errors: [],
  };

  records.set(id, record);
  meta.set(id, {
    fingerprint: fp,
    apiKey,
    aborted: false,
    bodies: {
      google: parsed.byProvider.google.body,
      microsoft: parsed.byProvider.microsoft.body,
      other: parsed.byProvider.other.body,
    },
    targets,
  });
  await persist(id);
  void runJob(id);
  return id;
}

// --- The run ---------------------------------------------------------------

class AbortedError extends Error {}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

function pushError(rec: ChangeLimitsJob, text: string) {
  if (rec.errors.length < MAX_STORED_ERRORS) rec.errors.push(text);
  else rec.errorsTruncated = true;
}

async function runJob(id: string) {
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m || !m.apiKey || !m.bodies || !m.targets) return;
  const apiKey = m.apiKey;
  const bodies = m.bodies;
  const targets = m.targets;
  const check = () => {
    if (m.aborted) throw new AbortedError();
  };
  const touch = async () => {
    rec.updatedAt = Date.now();
    await persist(id);
  };

  try {
    for (const [i, target] of targets.entries()) {
      check();
      const group = rec.groups[i];
      group.state = "running";
      await touch();
      // Each group is one provider, so it carries that provider's values.
      const body = bodies[target.provider];

      for (let at = 0; at < target.inboxes.length; at += UPDATE_CHUNK) {
        check();
        const slice = target.inboxes.slice(at, at + UPDATE_CHUNK);
        try {
          await acquireSlot();
          await plusvibePut({
            apiKey,
            path: "/account/bulk-update",
            body: { workspace_id: target.workspaceId, ids: slice.map((b) => b.id), ...body },
          });
          group.updated += slice.length;
          rec.progress.inboxesUpdated += slice.length;
        } catch (err) {
          group.failed += slice.length;
          rec.progress.inboxesFailed += slice.length;
          const names = slice.slice(0, 3).map((b) => b.email).join(", ");
          const more = slice.length > 3 ? `, +${slice.length - 3} more` : "";
          const text = `${slice.length} inbox${slice.length === 1 ? "" : "es"} were not updated (${names}${more}): ${msg(err)}`;
          group.error = group.error ? `${group.error} ${text}` : text;
          pushError(rec, `${target.workspaceName}: ${text}`);
        }
        await touch();
      }

      group.state =
        group.failed === 0 ? "done" : group.updated > 0 ? "partial" : "error";
      rec.progress.workspacesDone += 1;
      await touch();
    }

    rec.status = rec.progress.inboxesUpdated === 0 ? "error" : "done";
  } catch (err) {
    if (err instanceof AbortedError || m.aborted) rec.status = "aborted";
    else {
      pushError(rec, msg(err));
      rec.status = "error";
    }
  } finally {
    rec.finishedAt = Date.now();
    rec.updatedAt = rec.finishedAt;
    // Nothing sensitive outlives the run.
    m.apiKey = undefined;
    m.bodies = undefined;
    m.targets = undefined;
    await persist(id);
  }
}

// --- Query / control -------------------------------------------------------

function owned(apiKey: string, id: string) {
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m || m.fingerprint !== fingerprintKey(apiKey)) return null;
  return { rec, m };
}

export async function listJobs(apiKey: string): Promise<ChangeLimitsJob[]> {
  await loadOnce();
  const fp = fingerprintKey(apiKey);
  const out: ChangeLimitsJob[] = [];
  for (const [id, m] of meta) {
    if (m.fingerprint !== fp) continue;
    const rec = records.get(id);
    if (rec) out.push(rec);
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

/** Stops a running job. Inboxes already updated keep their new settings. */
export async function abortJob(apiKey: string, id: string): Promise<boolean> {
  await loadOnce();
  const o = owned(apiKey, id);
  if (!o) return false;
  o.m.aborted = true;
  return true;
}

export async function deleteJob(apiKey: string, id: string): Promise<boolean> {
  await loadOnce();
  const o = owned(apiKey, id);
  if (!o) return false;
  o.m.aborted = true;
  records.delete(id);
  meta.delete(id);
  try {
    await fs.unlink(fileFor(id));
  } catch {
    // already gone
  }
  return true;
}

export type { ChangeLimitsGroup };
