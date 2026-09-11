import "server-only";

import { createHash, randomUUID } from "crypto";
import { promises as fs, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { onShutdownFlush } from "@/lib/jobs/shutdown";
import { acquireSlot } from "@/lib/jobs/rate-limit";
import { plusvibePatch } from "@/lib/plusvibe-server";
import { fetchCampaignRaw, listCampaignsRaw, summarize } from "@/lib/plusvibe-campaigns";
import {
  IN_SCOPE_STATUSES,
  describeChanges,
  diffCampaign,
  patchBody,
  prepareChanges,
  unverified,
} from "@/lib/campaign-settings/settings";
import type {
  CampaignOutcome,
  CampaignSettingsJob,
  CampaignSettingsStartPayload,
  WorkspaceOutcome,
} from "@/lib/jobs/campaign-settings-types";
import { MAX_STORED_ERRORS } from "@/lib/jobs/campaign-settings-types";

// Server-side manager for Change Campaign Settings jobs.
//
// Runs in the background and reports as it goes. Per workspace the active
// campaigns are listed (their current settings come with the listing), then
// each one that differs from what is wanted gets one PATCH carrying only the
// settings that differ, and is read back to confirm. A campaign already set
// the wanted way is counted, not written.
//
// ONE JOB AT A TIME per API key — two jobs writing the same campaigns would
// only race each other.

const JOBS_BASE = process.env.JOBS_DIR || path.join(process.cwd(), ".jobs-data");
const JOBS_DIR = path.join(JOBS_BASE, "campaign-settings");
const PERSIST_EVERY = 5;

interface JobMeta {
  fingerprint: string;
  apiKey?: string;
  aborted: boolean;
}

const records = new Map<string, CampaignSettingsJob>();
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

const live = (r: CampaignSettingsJob) => r.status === "running";

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
        const parsed = JSON.parse(await fs.readFile(path.join(JOBS_DIR, f), "utf8")) as CampaignSettingsJob & { fingerprint?: string };
        const fingerprint = parsed.fingerprint ?? "";
        delete (parsed as { fingerprint?: string }).fingerprint;
        if (live(parsed)) parsed.status = "interrupted";
        parsed.workspaces = Array.isArray(parsed.workspaces) ? parsed.workspaces : [];
        parsed.changes = Array.isArray(parsed.changes) ? parsed.changes : [];
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
    super("A campaign settings job is already running — let it finish or stop it first.");
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

export async function createJob(apiKey: string, payload: CampaignSettingsStartPayload): Promise<string> {
  await loadOnce();
  const fp = fingerprintKey(apiKey);
  const running = activeIdFor(fp);
  if (running) throw new ActiveJobError(running);

  const prepared = prepareChanges(payload.changes);
  if (prepared.problems.length > 0) throw new Error(prepared.problems.join(" "));
  if (prepared.changes.length === 0) throw new Error("Pick at least one setting to change.");

  const id = randomUUID();
  const now = Date.now();
  const n = payload.workspaces.length;
  const record: CampaignSettingsJob = {
    id,
    label: `${describeChanges(prepared.changes)} · ${n} workspace${n === 1 ? "" : "s"}`,
    status: "running",
    createdAt: now,
    updatedAt: now,
    changes: prepared.changes,
    includeSubsequences: payload.includeSubsequences === true,
    workspaces: payload.workspaces.map((w) => ({
      workspaceId: w.id,
      workspaceName: w.name,
      state: "pending" as const,
      campaigns: [],
      skippedNotActive: 0,
    })),
    progress: { workspacesDone: 0, campaignsFound: 0, campaignsDone: 0, changed: 0, already: 0, failed: 0 },
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

function pushError(rec: CampaignSettingsJob, text: string) {
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
    for (const ws of rec.workspaces) {
      check();
      ws.state = "listing";
      await touch();

      let raws;
      try {
        await acquireSlot();
        raws = await listCampaignsRaw(apiKey, ws.workspaceId, {
          campaignType: rec.includeSubsequences ? "all" : "parent",
        });
      } catch (err) {
        ws.state = "error";
        ws.error = `Could not list the campaigns: ${msg(err)}`;
        pushError(rec, `${ws.workspaceName}: ${ws.error}`);
        rec.progress.workspacesDone += 1;
        await touch();
        continue;
      }

      // Only live campaigns. The status is checked here rather than trusted
      // to a query filter, so a paused or archived one is never touched.
      const active = raws.filter((c) => IN_SCOPE_STATUSES.has(String(c.status ?? "").toUpperCase()));
      ws.skippedNotActive = raws.length - active.length;
      const plans = active.map((raw) => {
        const s = summarize(raw);
        const needed = diffCampaign(rec.changes, raw);
        const outcome: CampaignOutcome = {
          campaignId: s.id,
          campaignName: s.name,
          campaignType: s.campaignType === "subseq" ? "subseq" : "parent",
          state: needed.length === 0 ? "already" : "pending",
          needed: needed.map((c) => c.key),
        };
        return { outcome, needed };
      });
      ws.campaigns = plans.map((p) => p.outcome);
      rec.progress.campaignsFound += ws.campaigns.length;
      ws.state = "updating";
      await touch();

      let sinceFlush = 0;
      for (const { outcome: c, needed } of plans) {
        check();
        if (c.state === "already") {
          rec.progress.already += 1;
          rec.progress.campaignsDone += 1;
          continue;
        }
        c.state = "updating";
        try {
          await acquireSlot();
          await plusvibePatch<unknown>({
            apiKey,
            path: "/campaign/update/campaign",
            body: patchBody(ws.workspaceId, c.campaignId, needed),
          });
          // Read back: the PATCH response doesn't echo the settings.
          await acquireSlot();
          const after = await fetchCampaignRaw(apiKey, ws.workspaceId, c.campaignId);
          const missing = after ? unverified(needed, after) : needed;
          c.verified = missing.length === 0;
          c.unverified = missing.map((x) => x.key);
          c.state = "changed";
          rec.progress.changed += 1;
          if (!c.verified) {
            pushError(rec, `${ws.workspaceName} · ${c.campaignName}: written, but ${missing.length} setting(s) did not read back as expected.`);
          }
        } catch (err) {
          if (err instanceof AbortedError || m.aborted) throw err;
          c.state = "error";
          c.error = msg(err);
          rec.progress.failed += 1;
          pushError(rec, `${ws.workspaceName} · ${c.campaignName}: ${c.error}`);
        }
        rec.progress.campaignsDone += 1;
        if (++sinceFlush >= PERSIST_EVERY) {
          sinceFlush = 0;
          await touch();
        }
      }
      ws.state = "done";
      rec.progress.workspacesDone += 1;
      await touch();
    }
    const allFailed = rec.workspaces.length > 0 && rec.workspaces.every((w) => w.state === "error");
    rec.status = allFailed ? "error" : "done";
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

export async function listJobs(apiKey: string): Promise<CampaignSettingsJob[]> {
  await loadOnce();
  const fp = fingerprintKey(apiKey);
  const out: CampaignSettingsJob[] = [];
  for (const [id, m] of meta) {
    if (m.fingerprint !== fp) continue;
    const rec = records.get(id);
    if (rec) out.push(rec);
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

/** Stops a running job. Campaigns already changed stay changed. */
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

export type { CampaignOutcome, WorkspaceOutcome };
