import "server-only";

import { createHash, randomUUID } from "crypto";
import { promises as fs, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { onShutdownFlush } from "@/lib/jobs/shutdown";
import { acquireSlot } from "@/lib/jobs/rate-limit";
import { listCampaigns } from "@/lib/plusvibe-campaigns";
import {
  CampaignEditError,
  editCampaignCopy,
} from "@/lib/copy-sections/apply-campaign";
import { validateEdit } from "@/lib/copy-sections/edit";
import type {
  CampaignOutcome,
  CopyReplaceJob,
  CopyReplaceStartPayload,
  WorkspaceOutcome,
} from "@/lib/jobs/copy-replace-types";
import { MAX_STORED_ERRORS } from "@/lib/jobs/copy-replace-types";

// Server-side manager for Bulk Find & Replace Copy jobs.
//
// Scan every campaign in the chosen workspaces, stop and show what would
// change, write only after confirmation. The scan is read-only; the apply
// re-reads each campaign and re-applies the edit from scratch, so a campaign
// edited by someone between the two is caught by its variation count and
// skipped rather than overwritten with a stale plan.
//
// ONE JOB AT A TIME per API key: a second scan while the first is waiting for
// confirmation would only confuse which summary is being confirmed.

const JOBS_BASE = process.env.JOBS_DIR || path.join(process.cwd(), ".jobs-data");
const JOBS_DIR = path.join(JOBS_BASE, "copy-replace");
const PERSIST_EVERY = 5;
/** Campaign statuses in scope — the ones whose copy is live or about to be. */
const IN_SCOPE = new Set(["ACTIVE", "PAUSED"]);

interface JobMeta {
  fingerprint: string;
  apiKey?: string;
  aborted: boolean;
}

const records = new Map<string, CopyReplaceJob>();
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
    // best-effort
  }
}

const live = (r: CopyReplaceJob) => r.status === "scanning" || r.status === "applying";

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
        const parsed = JSON.parse(await fs.readFile(path.join(JOBS_DIR, f), "utf8")) as CopyReplaceJob & { fingerprint?: string };
        const fingerprint = parsed.fingerprint ?? "";
        delete (parsed as { fingerprint?: string }).fingerprint;
        // Both live phases and the wait between them need the key, which
        // lived only in memory.
        if (live(parsed) || parsed.status === "awaiting_confirmation") parsed.status = "interrupted";
        parsed.workspaces = Array.isArray(parsed.workspaces) ? parsed.workspaces : [];
        parsed.errors = Array.isArray(parsed.errors) ? parsed.errors : [];
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
    super(
      "A bulk find & replace is already in progress — finish or cancel it first, so there is only ever one summary waiting to be confirmed."
    );
    this.name = "ActiveJobError";
  }
}

function activeIdFor(fp: string): string | null {
  for (const [id, m] of meta) {
    if (m.fingerprint !== fp) continue;
    const r = records.get(id);
    if (r && (live(r) || r.status === "awaiting_confirmation")) return id;
  }
  return null;
}

export async function createJob(apiKey: string, payload: CopyReplaceStartPayload): Promise<string> {
  await loadOnce();
  const fp = fingerprintKey(apiKey);
  const running = activeIdFor(fp);
  if (running) throw new ActiveJobError(running);

  if (payload.edit.kind !== "replace-text") {
    throw new Error("Only find & replace can run in bulk.");
  }
  const problems = validateEdit(payload.edit, 2);
  if (problems.length > 0) throw new Error(problems.join(" "));

  const id = randomUUID();
  const now = Date.now();
  const names = payload.workspaces.map((w) => w.name.trim()).filter(Boolean);
  const picked = payload.workspaces.length === 1 ? payload.workspaces[0].campaignIds : undefined;
  const scope = picked
    ? `${picked.length} campaign${picked.length === 1 ? "" : "s"} in ${names[0] ?? "1 workspace"}`
    : `${names.length} workspace${names.length === 1 ? "" : "s"}`;
  const record: CopyReplaceJob = {
    id,
    label: `"${payload.edit.find}" → "${payload.edit.replace}" · ${scope}`,
    status: "scanning",
    createdAt: now,
    updatedAt: now,
    edit: payload.edit,
    includeSubsequences: payload.includeSubsequences === true,
    workspaces: payload.workspaces.map((w) => ({
      workspaceId: w.id,
      workspaceName: w.name,
      state: "pending" as const,
      campaignIds: w.campaignIds && w.campaignIds.length > 0 ? w.campaignIds : undefined,
      campaigns: [],
      skippedOutOfScope: 0,
    })),
    progress: {
      workspacesScanned: 0,
      campaignsScanned: 0,
      campaignsToChange: 0,
      variationsToChange: 0,
      campaignsApplied: 0,
      campaignsFailed: 0,
      campaignsSkipped: 0,
    },
    errors: [],
  };
  records.set(id, record);
  meta.set(id, { fingerprint: fp, apiKey, aborted: false });
  await persist(id);
  void runScan(id);
  return id;
}

// --- Scan ------------------------------------------------------------------

class AbortedError extends Error {}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

function pushError(rec: CopyReplaceJob, text: string) {
  if (rec.errors.length < MAX_STORED_ERRORS) rec.errors.push(text);
  else rec.errorsTruncated = true;
}

async function runScan(id: string) {
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m || !m.apiKey) return;
  const apiKey = m.apiKey;
  const check = () => {
    if (m.aborted) throw new AbortedError();
  };

  try {
    for (const ws of rec.workspaces) {
      check();
      ws.state = "scanning";
      rec.updatedAt = Date.now();
      await persist(id);

      let list;
      try {
        await acquireSlot();
        list = await listCampaigns(apiKey, ws.workspaceId, {
          campaignType: rec.includeSubsequences ? "all" : "parent",
        });
      } catch (err) {
        ws.state = "error";
        ws.error = `Could not list the campaigns: ${msg(err)}`;
        pushError(rec, `${ws.workspaceName}: ${ws.error}`);
        rec.progress.workspacesScanned += 1;
        continue;
      }

      // A hand-picked list narrows to exactly those campaigns; the status rule
      // still applies, so one archived since it was picked is left alone.
      const picked = ws.campaignIds ? new Set(ws.campaignIds) : null;
      const candidates = picked ? list.filter((c) => picked.has(c.id)) : list;
      const inScope = candidates.filter((c) => IN_SCOPE.has(c.status.toUpperCase()));
      ws.skippedOutOfScope = candidates.length - inScope.length;
      ws.campaigns = inScope.map((c) => ({
        campaignId: c.id,
        campaignName: c.name,
        campaignType: c.campaignType === "subseq" ? "subseq" : "parent",
        status: c.status,
        state: "pending" as const,
        steps: [],
        liveVariations: 0,
        changed: 0,
      }));

      let sinceFlush = 0;
      for (const c of ws.campaigns) {
        check();
        c.state = "scanning";
        try {
          const out = await editCampaignCopy({
            apiKey,
            workspaceId: ws.workspaceId,
            campaignId: c.campaignId,
            edit: rec.edit,
            dryRun: true,
          });
          c.steps = out.steps.map((s) => ({ step: s.step, total: s.total, changed: s.changed }));
          c.liveVariations = out.liveVariations;
          c.changed = out.changed;
          c.state = out.changed > 0 ? "would-change" : "unchanged";
          if (out.changed > 0) {
            rec.progress.campaignsToChange += 1;
            rec.progress.variationsToChange += out.changed;
          }
        } catch (err) {
          if (err instanceof AbortedError || m.aborted) throw err;
          c.state = "error";
          c.error = msg(err);
          pushError(rec, `${ws.workspaceName} · ${c.campaignName}: ${c.error}`);
        }
        rec.progress.campaignsScanned += 1;
        if (++sinceFlush >= PERSIST_EVERY) {
          sinceFlush = 0;
          rec.updatedAt = Date.now();
          await persist(id);
        }
      }
      ws.state = "done";
      rec.progress.workspacesScanned += 1;
      rec.updatedAt = Date.now();
      await persist(id);
    }
    rec.status = "awaiting_confirmation";
  } catch (err) {
    if (err instanceof AbortedError || m.aborted) {
      rec.status = "aborted";
    } else {
      pushError(rec, msg(err));
      rec.status = "error";
    }
    // The key is only needed while the job can still go on to apply.
    m.apiKey = undefined;
  } finally {
    rec.updatedAt = Date.now();
    await persist(id);
  }
}

// --- Apply -----------------------------------------------------------------

export async function confirmJob(apiKey: string, id: string): Promise<"started" | "not-found" | "not-waiting" | "nothing"> {
  await loadOnce();
  const o = owned(apiKey, id);
  if (!o) return "not-found";
  if (o.rec.status !== "awaiting_confirmation") return "not-waiting";
  if (o.rec.progress.campaignsToChange === 0) return "nothing";
  // The confirming key is the one used to write — fresh from the browser, so
  // a job that waited a long time still has a key even if memory was cleared.
  o.m.apiKey = apiKey;
  o.rec.status = "applying";
  o.rec.confirmedAt = Date.now();
  o.rec.updatedAt = o.rec.confirmedAt;
  await persist(id);
  void runApply(id);
  return "started";
}

async function runApply(id: string) {
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m || !m.apiKey) return;
  const apiKey = m.apiKey;
  const check = () => {
    if (m.aborted) throw new AbortedError();
  };

  try {
    for (const ws of rec.workspaces) {
      let sinceFlush = 0;
      for (const c of ws.campaigns) {
        if (c.state !== "would-change") continue;
        check();
        c.state = "applying";
        try {
          const out = await editCampaignCopy({
            apiKey,
            workspaceId: ws.workspaceId,
            campaignId: c.campaignId,
            edit: rec.edit,
            // Refuses if the campaign's variations changed since the scan.
            expectedVariationCount: c.liveVariations,
          });
          c.steps = out.steps.map((s) => ({ step: s.step, total: s.total, changed: s.changed }));
          c.changed = out.changed;
          c.verified = out.verified;
          c.unverified = out.unverified;
          c.state = out.written ? "applied" : "unchanged";
          if (out.written) rec.progress.campaignsApplied += 1;
          if (out.written && !out.verified) {
            pushError(
              rec,
              `${ws.workspaceName} · ${c.campaignName}: written, but ${out.unverified.length} variation(s) did not read back as expected.`
            );
          }
        } catch (err) {
          if (err instanceof AbortedError || m.aborted) throw err;
          if (err instanceof CampaignEditError && err.status === 409) {
            c.state = "skipped";
            c.error = "Changed since the scan — skipped rather than overwritten. Run again to include it.";
            rec.progress.campaignsSkipped += 1;
          } else {
            c.state = "error";
            c.error = msg(err);
            rec.progress.campaignsFailed += 1;
          }
          pushError(rec, `${ws.workspaceName} · ${c.campaignName}: ${c.error}`);
        }
        if (++sinceFlush >= PERSIST_EVERY) {
          sinceFlush = 0;
          rec.updatedAt = Date.now();
          await persist(id);
        }
      }
      rec.updatedAt = Date.now();
      await persist(id);
    }
    rec.status = rec.progress.campaignsApplied === 0 && rec.progress.campaignsFailed > 0 ? "error" : "done";
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

function owned(apiKey: string, id: string) {
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m || m.fingerprint !== fingerprintKey(apiKey)) return null;
  return { rec, m };
}

export async function listJobs(apiKey: string): Promise<CopyReplaceJob[]> {
  await loadOnce();
  const fp = fingerprintKey(apiKey);
  const out: CopyReplaceJob[] = [];
  for (const [id, m] of meta) {
    if (m.fingerprint !== fp) continue;
    const rec = records.get(id);
    if (rec) out.push(rec);
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

/** Stops a scan or an apply. Campaigns already written stay written. */
export async function abortJob(apiKey: string, id: string): Promise<boolean> {
  await loadOnce();
  const o = owned(apiKey, id);
  if (!o) return false;
  o.m.aborted = true;
  return true;
}

/** Declines a summary that is waiting for confirmation. Nothing was written. */
export async function cancelJob(apiKey: string, id: string): Promise<boolean> {
  await loadOnce();
  const o = owned(apiKey, id);
  if (!o || o.rec.status !== "awaiting_confirmation") return false;
  o.rec.status = "cancelled";
  o.rec.finishedAt = Date.now();
  o.rec.updatedAt = o.rec.finishedAt;
  o.m.apiKey = undefined;
  await persist(id);
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

export type { CampaignOutcome, WorkspaceOutcome };
