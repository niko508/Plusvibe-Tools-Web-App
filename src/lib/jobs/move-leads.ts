import "server-only";

import { createHash, randomUUID } from "crypto";
import { promises as fs, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { plusvibePost } from "@/lib/plusvibe-server";
import { acquireSlot } from "@/lib/jobs/rate-limit";
import { onShutdownFlush } from "@/lib/jobs/shutdown";
import {
  fetchCampaignLeads,
  leadToPayload,
  type LeadPayload,
} from "@/lib/plusvibe-leads";
import type {
  MoveLeadsJob,
  MoveLeadsStartPayload,
  MovePair,
} from "@/lib/jobs/move-leads-types";
import { MAX_STORED_ERRORS } from "@/lib/jobs/move-leads-types";

// Server-side manager for lead-move jobs. Runs in the Node process so the work
// survives the browser tab closing, and persists to disk so results can be
// read again later. The API key lives in memory only. Every Plusvibe call goes
// through the shared global rate limiter, so several pairs running at once stay
// within the account's single 5 req/s budget instead of competing.

const JOBS_BASE = process.env.JOBS_DIR || path.join(process.cwd(), ".jobs-data");
const JOBS_DIR = path.join(JOBS_BASE, "move-leads");
const CHUNK = 100;
const PERSIST_EVERY = 2; // chunks between disk flushes

interface JobMeta {
  fingerprint: string;
  apiKey?: string;
  workspaceId?: string;
  pair?: MovePair;
  aborted: boolean;
}

const records = new Map<string, MoveLeadsJob>();
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
    // Best-effort; a failed write must not kill the run.
  }
}

// Persist any running job as interrupted when the container is torn down.
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

async function loadOnce() {
  if (loaded) return;
  loaded = true;
  try {
    await fs.mkdir(JOBS_DIR, { recursive: true });
    const files = await fs.readdir(JOBS_DIR);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const rawText = await fs.readFile(path.join(JOBS_DIR, f), "utf8");
        const parsed = JSON.parse(rawText) as MoveLeadsJob & {
          fingerprint?: string;
        };
        const fingerprint = parsed.fingerprint ?? "";
        delete (parsed as { fingerprint?: string }).fingerprint;
        if (parsed.status === "running") {
          parsed.status = "interrupted";
          parsed.phase = "finished";
        }
        records.set(parsed.id, parsed);
        meta.set(parsed.id, { fingerprint, aborted: false });
      } catch {
        // skip unreadable record
      }
    }
  } catch {
    // nothing stored yet
  }
}

// --- Creation --------------------------------------------------------------

/** Creates one job per pair and starts them; returns the new job ids. */
export async function createJobs(
  apiKey: string,
  payload: MoveLeadsStartPayload
): Promise<string[]> {
  await loadOnce();
  const fingerprint = fingerprintKey(apiKey);
  const ids: string[] = [];

  for (const pair of payload.pairs) {
    const id = randomUUID();
    const now = Date.now();
    const record: MoveLeadsJob = {
      id,
      label: `${pair.sourceName} → ${pair.destinationName}`,
      status: "running",
      createdAt: now,
      updatedAt: now,
      workspaceName: payload.workspaceName,
      sourceName: pair.sourceName,
      destinationName: pair.destinationName,
      phase: "collecting",
      progress: {
        requested: pair.count,
        found: 0,
        processed: 0,
        added: 0,
        alreadyInDestination: 0,
        deletedFromSource: 0,
      },
      errors: [],
    };
    records.set(id, record);
    meta.set(id, {
      fingerprint,
      apiKey,
      workspaceId: payload.workspaceId,
      pair,
      aborted: false,
    });
    await persist(id);
    ids.push(id);
    void runJob(id);
  }

  return ids;
}

// --- Runner ----------------------------------------------------------------

interface AddResponse {
  leads_uploaded?: number;
  already_in_campaign?: number;
}

async function runJob(id: string) {
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m || !m.apiKey || !m.pair || !m.workspaceId) return;

  const apiKey = m.apiKey;
  const workspace_id = m.workspaceId;
  const { sourceCampaignId: source, destinationCampaignId: destination, count } =
    m.pair;

  try {
    // --- Collect ---------------------------------------------------------
    rec.phase = "collecting";
    await persist(id);
    const { leads } = await fetchCampaignLeads(
      apiKey,
      workspace_id,
      source,
      count
    );
    if (m.aborted) throw new AbortedError();

    const payloads: LeadPayload[] = leads
      .map(leadToPayload)
      .filter((p) => p.email);
    rec.progress.found = payloads.length;
    rec.phase = "moving";
    rec.updatedAt = Date.now();
    await persist(id);

    if (payloads.length === 0) {
      pushError(rec, "No not-contacted leads found in the source campaign.");
      rec.status = "done";
      rec.phase = "finished";
      return;
    }

    // --- Move in chunks: add, verify, then delete -------------------------
    let sinceFlush = 0;
    for (let i = 0; i < payloads.length; i += CHUNK) {
      if (m.aborted) throw new AbortedError();
      const chunk = payloads.slice(i, i + CHUNK);

      await acquireSlot();
      if (m.aborted) throw new AbortedError();

      let addRes: AddResponse;
      try {
        addRes = await plusvibePost<AddResponse>({
          apiKey,
          path: "/lead/add",
          body: {
            workspace_id,
            campaign_id: destination,
            // All skip flags off: these leads are currently in the source
            // campaign, so any skip would drop the add and the delete below
            // would then lose them.
            skip_if_in_workspace: false,
            skip_lead_in_active_pause_camp: false,
            skip_lead_for_active_only_camp: false,
            resume_camp_if_completed: false,
            is_overwrite: false,
            leads: chunk,
          },
        });
      } catch (err) {
        pushError(
          rec,
          `Adding leads ${i + 1}–${i + chunk.length} failed: ${msg(err)}. Nothing was deleted from the source.`
        );
        rec.status = "error";
        break;
      }

      const uploaded = Number(addRes?.leads_uploaded ?? 0) || 0;
      const existing = Number(addRes?.already_in_campaign ?? 0) || 0;
      const landed = uploaded + existing;
      rec.progress.added += uploaded;
      rec.progress.alreadyInDestination += existing;

      // Only delete once the add is confirmed — /lead/delete gives no per-email
      // detail and is treated as irreversible, so a partial add stops the run
      // rather than risking leads that exist in neither campaign.
      if (landed < chunk.length) {
        pushError(
          rec,
          `Only ${landed} of ${chunk.length} leads landed in the destination (uploaded ${uploaded}, already there ${existing}). Nothing was deleted from the source — stopped here so no leads are lost.`
        );
        rec.status = "error";
        break;
      }

      await acquireSlot();
      if (m.aborted) throw new AbortedError();

      try {
        await plusvibePost<{ status?: string }>({
          apiKey,
          path: "/lead/delete",
          body: {
            workspace_id,
            campaign_id: source, // omitting this deletes workspace-wide
            delete_all_from_company: false,
            delete_list: chunk.map((c) => c.email),
          },
        });
        rec.progress.deletedFromSource += chunk.length;
      } catch (err) {
        pushError(
          rec,
          `Leads ${i + 1}–${i + chunk.length} were added to the destination but could not be removed from the source: ${msg(err)}. They now exist in both campaigns.`
        );
        rec.status = "error";
        break;
      }

      rec.progress.processed += chunk.length;
      rec.updatedAt = Date.now();
      if (++sinceFlush >= PERSIST_EVERY) {
        sinceFlush = 0;
        void persist(id);
      }
    }

    if (rec.status === "running") rec.status = "done";
  } catch (err) {
    if (err instanceof AbortedError || m.aborted) {
      rec.status = "aborted";
    } else {
      pushError(rec, msg(err));
      rec.status = "error";
    }
  } finally {
    rec.phase = "finished";
    rec.updatedAt = Date.now();
    m.apiKey = undefined;
    m.pair = undefined;
    m.workspaceId = undefined;
    await persist(id);
  }
}

class AbortedError extends Error {}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

function pushError(rec: MoveLeadsJob, text: string) {
  if (rec.errors.length < MAX_STORED_ERRORS) rec.errors.push(text);
}

// --- Query / control (scoped by API key fingerprint) -----------------------

export async function getJob(
  apiKey: string,
  id: string
): Promise<MoveLeadsJob | null> {
  await loadOnce();
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m || m.fingerprint !== fingerprintKey(apiKey)) return null;
  return rec;
}

export async function listJobs(apiKey: string): Promise<MoveLeadsJob[]> {
  await loadOnce();
  const fp = fingerprintKey(apiKey);
  const out: MoveLeadsJob[] = [];
  for (const [id, m] of meta) {
    if (m.fingerprint !== fp) continue;
    const rec = records.get(id);
    if (rec) out.push(rec);
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

export async function countRunning(apiKey: string): Promise<number> {
  const jobs = await listJobs(apiKey);
  return jobs.filter((j) => j.status === "running").length;
}

export async function abortJob(apiKey: string, id: string): Promise<boolean> {
  await loadOnce();
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m || m.fingerprint !== fingerprintKey(apiKey)) return false;
  m.aborted = true;
  return true;
}
