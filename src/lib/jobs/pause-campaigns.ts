import "server-only";

import { createHash, randomUUID } from "crypto";
import { promises as fs, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { onShutdownFlush } from "@/lib/jobs/shutdown";
import { acquireSlot } from "@/lib/jobs/rate-limit";
import { plusvibePost } from "@/lib/plusvibe-server";
import { listCampaigns } from "@/lib/plusvibe-campaigns";
import {
  isResumeDue,
  labelFor,
  orderForResume,
  planPause,
  validateResumeAt,
} from "@/lib/pause-campaigns/plan";
import type {
  PauseCampaignsJob,
  PauseCampaignsStartPayload,
  PausePlan,
  PausePlanWorkspace,
  PausedCampaign,
  WorkspaceOutcome,
} from "@/lib/jobs/pause-campaigns-types";
import { MAX_STORED_ERRORS } from "@/lib/jobs/pause-campaigns-types";

// Server-side manager for Pause Campaigns jobs.
//
// Two passes, possibly days apart:
//   pause   list every campaign in each workspace, pause the ACTIVE ones —
//           parents and sub-sequences alike — and record each one
//   resume  on the scheduled date (or on demand), launch exactly the campaigns
//           the pause pass recorded, parents first
//
// The resume is what makes this different from the other job managers, which
// finish within minutes. A resume can be due long after every browser tab is
// closed and, on Railway, after the process has been replaced. So:
//
//  - A scheduler in this process wakes every minute and fires any resume that
//    is due. It is started from instrumentation.ts at boot, not lazily on the
//    first request, so a restart with nobody looking still fires on time.
//  - The record is on disk with everything the resume needs except the key.
//  - The key: the one that paused the campaigns stays in memory while the
//    resume is pending. After a restart that is gone, and PLUSVIBE_API_KEY on
//    the server stands in. With neither, the resume is marked blocked rather
//    than silently skipped, and the UI offers "Resume now" with the browser's
//    key.

const JOBS_BASE = process.env.JOBS_DIR || path.join(process.cwd(), ".jobs-data");
const JOBS_DIR = path.join(JOBS_BASE, "pause-campaigns");
const TICK_MS = 60_000;
const PERSIST_EVERY = 5;

interface JobMeta {
  fingerprint: string;
  apiKey?: string;
  aborted: boolean;
}

const records = new Map<string, PauseCampaignsJob>();
const meta = new Map<string, JobMeta>();
let loaded = false;

export function serverApiKey(): string | null {
  return process.env.PLUSVIBE_API_KEY?.trim() || null;
}

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
    // best-effort; a failed write must not kill the run
  }
}

function flushRunningSync() {
  const live = (r: PauseCampaignsJob) =>
    r.status === "running" || r.status === "resuming";
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
    // A resume cut off part-way goes back to "paused": its date is in the
    // past, so the scheduler picks it straight back up after the restart and
    // finishes the campaigns it hadn't reached. A pause cut off is
    // "interrupted" — its date, if any, still applies to what got paused.
    rec.status = rec.status === "resuming" ? "paused" : "interrupted";
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

function migrateRecord(raw: PauseCampaignsJob): PauseCampaignsJob {
  const rec = raw;
  rec.workspaces = Array.isArray(rec.workspaces) ? rec.workspaces : [];
  for (const w of rec.workspaces) {
    w.campaigns = Array.isArray(w.campaigns) ? w.campaigns : [];
    w.pauseErrors = Array.isArray(w.pauseErrors) ? w.pauseErrors : [];
    w.scanned = w.scanned ?? 0;
    w.skipped = w.skipped ?? 0;
    w.state = w.state ?? "pending";
  }
  rec.errors = Array.isArray(rec.errors) ? rec.errors : [];
  rec.createdAt = rec.createdAt || Date.now();
  rec.updatedAt = rec.updatedAt || rec.createdAt;
  return rec;
}

async function loadOnce() {
  if (loaded) return;
  loaded = true;
  try {
    await fs.mkdir(JOBS_DIR, { recursive: true });
    for (const f of await fs.readdir(JOBS_DIR)) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(JOBS_DIR, f), "utf8");
        const parsed = JSON.parse(raw) as PauseCampaignsJob & {
          fingerprint?: string;
        };
        const fingerprint = parsed.fingerprint ?? "";
        delete (parsed as { fingerprint?: string }).fingerprint;
        if (parsed.status === "running") parsed.status = "interrupted";
        if (parsed.status === "resuming") parsed.status = "paused";
        records.set(parsed.id, migrateRecord(parsed));
        meta.set(parsed.id, { fingerprint, aborted: false });
      } catch {
        // skip corrupt record
      }
    }
  } catch {
    // nothing to load
  }
}

// --- Scheduler -------------------------------------------------------------

let schedulerStarted = false;

/**
 * Starts the once-a-minute check for due resumes. Idempotent.
 *
 * Called from instrumentation.ts when the server boots, and again from the
 * first request as a belt-and-braces measure — either way it runs once.
 */
export async function bootScheduler() {
  await loadOnce();
  if (schedulerStarted) return;
  schedulerStarted = true;
  const timer = setInterval(() => void tick(), TICK_MS);
  // Never keep the process alive just for this.
  timer.unref?.();
  // A resume that came due while the process was down should not wait a
  // further minute.
  void tick();
}

async function tick() {
  const now = Date.now();
  for (const [id, rec] of records) {
    if (!isResumeDue(rec, now)) continue;
    await resumeJob(id, "scheduled");
  }
}

// --- Planning (dry run) ----------------------------------------------------

/** Workspaces with a resume still pending, from any job under this key. */
function pendingResumes(fp: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, m] of meta) {
    if (m.fingerprint !== fp) continue;
    const rec = records.get(id);
    if (!rec || rec.resumeAt === undefined || rec.resumedAt !== undefined) continue;
    if (!["paused", "aborted", "interrupted", "running"].includes(rec.status)) continue;
    for (const w of rec.workspaces) {
      const prev = out.get(w.workspaceId);
      if (prev === undefined || rec.resumeAt < prev) out.set(w.workspaceId, rec.resumeAt);
    }
  }
  return out;
}

export async function planJob(
  apiKey: string,
  payload: PauseCampaignsStartPayload
): Promise<PausePlan> {
  await loadOnce();
  const pending = pendingResumes(fingerprintKey(apiKey));
  const workspaces: PausePlanWorkspace[] = [];

  for (const ws of payload.workspaces) {
    const base = { workspaceId: ws.id, workspaceName: ws.name };
    try {
      await acquireSlot();
      const plan = planPause(
        await listCampaigns(apiKey, ws.id, { campaignType: "all" })
      );
      workspaces.push({
        ...base,
        scanned: plan.toPause.length + plan.skipped,
        parents: plan.parents,
        subsequences: plan.subsequences,
        skipped: plan.skipped,
        pendingResumeAt: pending.get(ws.id),
      });
    } catch (err) {
      workspaces.push({
        ...base,
        scanned: 0,
        parents: 0,
        subsequences: 0,
        skipped: 0,
        pendingResumeAt: pending.get(ws.id),
        error: msg(err),
      });
    }
  }

  return {
    workspaces,
    totals: {
      parents: workspaces.reduce((s, w) => s + w.parents, 0),
      subsequences: workspaces.reduce((s, w) => s + w.subsequences, 0),
      skipped: workspaces.reduce((s, w) => s + w.skipped, 0),
      errors: workspaces.filter((w) => w.error).length,
    },
  };
}

// --- Creation --------------------------------------------------------------

export async function createJob(
  apiKey: string,
  payload: PauseCampaignsStartPayload
): Promise<string> {
  await loadOnce();
  void bootScheduler();

  if (payload.resumeAt !== undefined) {
    const problem = validateResumeAt(payload.resumeAt);
    if (problem) throw new Error(problem);
  }

  const id = randomUUID();
  const now = Date.now();
  const record: PauseCampaignsJob = {
    id,
    label: labelFor(payload.workspaces.map((w) => w.name)),
    status: "running",
    createdAt: now,
    updatedAt: now,
    workspaces: payload.workspaces.map((w) => ({
      workspaceId: w.id,
      workspaceName: w.name,
      state: "pending" as const,
      scanned: 0,
      skipped: 0,
      pauseErrors: [],
      campaigns: [],
    })),
    resumeAt: payload.resumeAt,
    errors: [],
  };

  records.set(id, record);
  meta.set(id, { fingerprint: fingerprintKey(apiKey), apiKey, aborted: false });
  await persist(id);
  void runPause(id);
  return id;
}

// --- Pause pass ------------------------------------------------------------

class AbortedError extends Error {}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

function pushError(rec: PauseCampaignsJob, text: string) {
  if (rec.errors.length < MAX_STORED_ERRORS) rec.errors.push(text);
  else rec.errorsTruncated = true;
}

async function runPause(id: string) {
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
      ws.state = "running";
      rec.updatedAt = Date.now();
      await persist(id);

      let plan;
      try {
        await acquireSlot();
        plan = planPause(
          await listCampaigns(apiKey, ws.workspaceId, { campaignType: "all" })
        );
      } catch (err) {
        ws.state = "error";
        ws.error = `Could not list the campaigns: ${msg(err)}. Nothing in this workspace was paused.`;
        pushError(rec, `${ws.workspaceName}: ${ws.error}`);
        continue;
      }
      ws.scanned = plan.toPause.length + plan.skipped;
      ws.skipped = plan.skipped;

      let sinceFlush = 0;
      for (const c of plan.toPause) {
        check();
        try {
          await acquireSlot();
          await plusvibePost<{ status?: string }>({
            apiKey,
            path: "/campaign/pause",
            body: { workspace_id: ws.workspaceId, campaign_id: c.id },
          });
          const paused: PausedCampaign = {
            id: c.id,
            name: c.name,
            kind: c.kind,
            parentId: c.parentId,
            pausedAt: Date.now(),
          };
          ws.campaigns.push(paused);
        } catch (err) {
          if (err instanceof AbortedError || m.aborted) throw err;
          ws.pauseErrors.push({ id: c.id, name: c.name, reason: msg(err) });
        }
        // Persisted as it goes: if the process dies mid-way, the record still
        // says which campaigns are paused, and the resume still covers them.
        if (++sinceFlush >= PERSIST_EVERY) {
          sinceFlush = 0;
          rec.updatedAt = Date.now();
          await persist(id);
        }
      }
      ws.state = ws.pauseErrors.length > 0 ? "error" : "done";
      rec.updatedAt = Date.now();
      await persist(id);
    }
    rec.status = rec.resumeAt !== undefined ? "paused" : "done";
  } catch (err) {
    if (err instanceof AbortedError || m.aborted) {
      rec.status = "aborted";
      for (const ws of rec.workspaces) {
        if (ws.state === "running") ws.state = "error";
        if (ws.state === "pending") ws.state = "skipped";
      }
    } else {
      pushError(rec, msg(err));
      rec.status = "error";
    }
  } finally {
    rec.updatedAt = Date.now();
    // The key is kept only while a resume is still to come.
    if (rec.resumeAt === undefined || !hasPausedCampaigns(rec)) m.apiKey = undefined;
    await persist(id);
  }
}

function hasPausedCampaigns(rec: PauseCampaignsJob): boolean {
  return rec.workspaces.some((w) => w.campaigns.length > 0);
}

// --- Resume pass -----------------------------------------------------------

/**
 * Turns the recorded campaigns back on. Safe to call more than once: campaigns
 * already resumed are skipped, so a pass cut off part-way finishes on retry.
 *
 * Returns false only when there was no key to do it with.
 */
export async function resumeJob(
  id: string,
  trigger: "scheduled" | "manual",
  browserKey?: string
): Promise<boolean> {
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m) return false;
  if (rec.status === "resuming") return true; // already in flight

  const source = browserKey ? "browser" : m.apiKey ? "memory" : serverApiKey() ? "server" : null;
  const apiKey = browserKey ?? m.apiKey ?? serverApiKey();
  if (!apiKey || !source) {
    rec.resumeBlocked = "no-key";
    rec.updatedAt = Date.now();
    await persist(id);
    return false;
  }

  // Set before any await, so a second tick or a click during the pass can't
  // start a second one.
  rec.status = "resuming";
  rec.resumeTrigger = trigger;
  rec.resumeKeySource = source;
  rec.resumeBlocked = undefined;
  rec.updatedAt = Date.now();
  await persist(id);

  let attempted = 0;
  let succeeded = 0;
  for (const ws of rec.workspaces) {
    let sinceFlush = 0;
    // Parents first: Plusvibe won't activate a sub-sequence under a parent
    // that is still paused.
    for (const c of orderForResume(ws.campaigns)) {
      if (c.resumedAt !== undefined) continue;
      attempted += 1;
      try {
        await acquireSlot();
        await plusvibePost<{ status?: string }>({
          apiKey,
          path: "/campaign/launch",
          body: { workspace_id: ws.workspaceId, campaign_id: c.id },
        });
        c.resumedAt = Date.now();
        c.resumeError = undefined;
        succeeded += 1;
      } catch (err) {
        c.resumeError = msg(err);
      }
      if (++sinceFlush >= PERSIST_EVERY) {
        sinceFlush = 0;
        rec.updatedAt = Date.now();
        await persist(id);
      }
    }
  }

  rec.resumedAt = Date.now();
  rec.updatedAt = rec.resumedAt;
  // Every one failing is a run that did nothing — worth the loud status. Some
  // failing is reported per campaign.
  rec.status = attempted > 0 && succeeded === 0 ? "error" : "done";
  if (rec.status === "error") {
    pushError(rec, `None of the ${attempted} campaigns could be resumed.`);
  }
  m.apiKey = undefined;
  await persist(id);
  return true;
}

// --- Query / control -------------------------------------------------------

export async function listJobs(apiKey: string): Promise<PauseCampaignsJob[]> {
  await loadOnce();
  void bootScheduler();
  const fp = fingerprintKey(apiKey);
  const out: PauseCampaignsJob[] = [];
  for (const [id, m] of meta) {
    if (m.fingerprint !== fp) continue;
    const rec = records.get(id);
    if (rec) out.push(rec);
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

function owned(apiKey: string, id: string) {
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m || m.fingerprint !== fingerprintKey(apiKey)) return null;
  return { rec, m };
}

/** Stops a pause pass. What is already paused stays paused and recorded. */
export async function abortJob(apiKey: string, id: string): Promise<boolean> {
  await loadOnce();
  const o = owned(apiKey, id);
  if (!o) return false;
  o.m.aborted = true;
  return true;
}

/** Runs the resume now, with the caller's key, whatever the schedule said. */
export async function resumeNow(apiKey: string, id: string): Promise<
  "started" | "nothing-to-resume" | "not-found" | "busy"
> {
  await loadOnce();
  const o = owned(apiKey, id);
  if (!o) return "not-found";
  if (o.rec.status === "running" || o.rec.status === "resuming") return "busy";
  if (!hasPausedCampaigns(o.rec)) return "nothing-to-resume";
  // Resumed already but with failures: allow a retry of the failed ones.
  if (o.rec.resumedAt !== undefined) {
    const anyFailed = o.rec.workspaces.some((w) =>
      w.campaigns.some((c) => c.resumedAt === undefined)
    );
    if (!anyFailed) return "nothing-to-resume";
    o.rec.resumedAt = undefined;
  }
  void resumeJob(id, "manual", apiKey);
  return "started";
}

/** Drops the scheduled resume. The campaigns stay paused. */
export async function cancelResume(apiKey: string, id: string): Promise<boolean> {
  await loadOnce();
  const o = owned(apiKey, id);
  if (!o) return false;
  if (o.rec.resumeAt === undefined || o.rec.resumedAt !== undefined) return false;
  o.rec.resumeAt = undefined;
  o.rec.resumeBlocked = undefined;
  if (o.rec.status === "paused") o.rec.status = "done";
  o.rec.updatedAt = Date.now();
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
