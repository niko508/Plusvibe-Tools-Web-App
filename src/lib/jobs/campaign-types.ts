import "server-only";

import { createHash, randomUUID } from "crypto";
import { promises as fs, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { onShutdownFlush } from "@/lib/jobs/shutdown";
import {
  fetchCampaignLeads,
  leadToPayload,
  type LeadPayload,
  type RawLead,
} from "@/lib/plusvibe-leads";
import { moveLeadChunk, MOVE_CHUNK } from "@/lib/move-leads-core";
import { resolveLeadEsps } from "@/lib/campaign-types/resolve-esp";
import { planSplit } from "@/lib/campaign-types/split";
import { applyOptOutToCampaign } from "@/lib/campaign-types/apply-opt-out";
import type {
  CampaignRole,
  CampaignTypesJob,
  CampaignTypesStartPayload,
  MoveTarget,
  OptOutTarget,
  RoleCampaign,
} from "@/lib/jobs/campaign-types-types";
import { MAX_STORED_ERRORS } from "@/lib/jobs/campaign-types-types";

// Server-side manager for Create All Campaign Types jobs.
//
// Three phases, in order:
//   1 sorting     collect the source campaign's NOT_CONTACTED leads and split
//                 them into Microsoft / everything-else by MX lookup
//   2 optOutCopy  append the opt-out spintax to step 1 of the two Opt Out
//                 campaigns
//   3 moving      move each bucket into its campaign (add → verify → delete)
//
// Runs in the Node process so the work survives the tab closing, and persists
// to disk so a job can be read back later. The API key is memory-only.
//
// ONE JOB AT A TIME per API key: the phases move leads out of a live campaign,
// and two overlapping runs over the same source would double-move.

const JOBS_BASE = process.env.JOBS_DIR || path.join(process.cwd(), ".jobs-data");
const JOBS_DIR = path.join(JOBS_BASE, "campaign-types");
// Enough headroom for the biggest run described (20k), with slack.
const MAX_LEADS = 100_000;
const PERSIST_EVERY = 5; // flush every N chunks

interface JobMeta {
  fingerprint: string;
  apiKey?: string;
  workspaceId?: string;
  payload?: CampaignTypesStartPayload;
  aborted: boolean;
}

const records = new Map<string, CampaignTypesJob>();
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
    // best-effort; a failed write must not kill the run
  }
}

function flushRunningSync() {
  if (![...records.values()].some((r) => r.status === "running")) return;
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

async function loadOnce() {
  if (loaded) return;
  loaded = true;
  try {
    await ensureDir();
    for (const f of await fs.readdir(JOBS_DIR)) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(JOBS_DIR, f), "utf8");
        const parsed = JSON.parse(raw) as CampaignTypesJob & {
          fingerprint?: string;
        };
        const fingerprint = parsed.fingerprint ?? "";
        delete (parsed as { fingerprint?: string }).fingerprint;
        if (parsed.status === "running") {
          parsed.status = "interrupted";
          parsed.updatedAt = parsed.updatedAt || Date.now();
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

// --- Creation --------------------------------------------------------------

export class ActiveJobError extends Error {
  constructor(readonly activeJobId: string) {
    super(
      "A Create All Campaign Types job is already running. Wait for it to finish (or stop it) before starting another — two runs over the same campaigns would move the same leads twice."
    );
    this.name = "ActiveJobError";
  }
}

/** The one running job for this API key, if any. */
export async function activeJob(apiKey: string): Promise<CampaignTypesJob | null> {
  await loadOnce();
  const fp = fingerprintKey(apiKey);
  for (const [id, m] of meta) {
    if (m.fingerprint !== fp) continue;
    const rec = records.get(id);
    if (rec?.status === "running") return rec;
  }
  return null;
}

function roleName(campaigns: RoleCampaign[], role: CampaignRole): string {
  return campaigns.find((c) => c.role === role)?.name ?? role;
}

function roleId(campaigns: RoleCampaign[], role: CampaignRole): string {
  return campaigns.find((c) => c.role === role)?.campaignId ?? "";
}

export async function createJob(
  apiKey: string,
  payload: CampaignTypesStartPayload
): Promise<string> {
  await loadOnce();

  const running = await activeJob(apiKey);
  if (running) throw new ActiveJobError(running.id);

  const id = randomUUID();
  const now = Date.now();
  const { campaigns } = payload;

  const optOutTargets: OptOutTarget[] = payload.skipOptOutCopy
    ? []
    : (["optOut", "blueOptOut"] as const).map((role) => ({
        role,
        name: roleName(campaigns, role),
        state: "pending" as const,
        applied: [],
        alreadyPresent: [],
      }));

  const moveTargets: MoveTarget[] = (
    ["blue", "blueOptOut", "optOut"] as const
  ).map((role) => ({
    role,
    name: roleName(campaigns, role),
    planned: 0,
    moved: 0,
    state: "pending" as const,
  }));

  const record: CampaignTypesJob = {
    id,
    label: roleName(campaigns, "source"),
    status: "running",
    phase: "sorting",
    phaseStates: {
      sorting: "running",
      optOutCopy: payload.skipOptOutCopy ? "skipped" : "pending",
      moving: "pending",
    },
    createdAt: now,
    updatedAt: now,
    workspaceName: payload.workspaceName,
    campaigns,
    sorting: {
      leadsFound: 0,
      microsoft: 0,
      other: 0,
      domainsTotal: 0,
      domainsResolved: 0,
      unresolvedDomains: 0,
      fromLeadField: 0,
    },
    optOut: optOutTargets,
    moving: {
      targets: moveTargets,
      staysInSource: 0,
      processed: 0,
      plannedTotal: 0,
    },
    errors: [],
  };

  records.set(id, record);
  meta.set(id, {
    fingerprint: fingerprintKey(apiKey),
    apiKey,
    workspaceId: payload.workspaceId,
    payload,
    aborted: false,
  });

  await persist(id);
  void runJob(id);
  return id;
}

// --- Runner ----------------------------------------------------------------

class AbortedError extends Error {}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

function pushError(rec: CampaignTypesJob, text: string) {
  if (rec.errors.length < MAX_STORED_ERRORS) rec.errors.push(text);
  else rec.errorsTruncated = true;
}

async function runJob(id: string) {
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m || !m.apiKey || !m.workspaceId || !m.payload) return;

  const apiKey = m.apiKey;
  const workspaceId = m.workspaceId;
  const { campaigns } = m.payload;
  const sourceId = roleId(campaigns, "source");
  const check = () => {
    if (m.aborted) throw new AbortedError();
  };

  try {
    // --- Phase 1: sorting leads ------------------------------------------
    rec.phase = "sorting";
    rec.phaseStates.sorting = "running";
    await persist(id);

    const { leads, wrongStatus, hitPageLimit } = await fetchCampaignLeads(
      apiKey,
      workspaceId,
      sourceId,
      MAX_LEADS
    );
    check();

    rec.sorting.leadsFound = leads.length;
    rec.sorting.hitPageLimit = hitPageLimit;
    if (hitPageLimit) {
      pushError(
        rec,
        `Stopped collecting at ${leads.length} leads — the paging budget ran out before the campaign did. Those collected are still split and moved; run again for the rest.`
      );
    }
    if (wrongStatus > 0) {
      pushError(
        rec,
        `${wrongStatus} lead(s) came back with a status other than NOT_CONTACTED and were skipped — the API's status filter appears not to be applied. Nothing already-contacted was moved.`
      );
    }
    await persist(id);

    const resolution = await resolveLeadEsps(leads, {
      isAborted: () => m.aborted,
      onProgress: (done, total) => {
        rec.sorting.domainsResolved = done;
        rec.sorting.domainsTotal = total;
        rec.updatedAt = Date.now();
      },
    });
    check();

    rec.sorting.microsoft = resolution.microsoft.length;
    rec.sorting.other = resolution.other.length;
    rec.sorting.unresolvedDomains = resolution.unresolvedDomains.length;
    rec.sorting.fromLeadField = resolution.fromLeadField;
    rec.sorting.domainsTotal = resolution.domainsLookedUp;
    rec.sorting.domainsResolved = resolution.domainsLookedUp;
    if (resolution.unresolvedDomains.length > 0) {
      pushError(
        rec,
        `${resolution.unresolvedDomains.length} domain(s) could not be resolved (e.g. ${resolution.unresolvedDomains.slice(0, 5).join(", ")}). Their leads were treated as non-Microsoft.`
      );
    }
    rec.phaseStates.sorting = "done";
    await persist(id);

    // --- Phase 2: opt-out copy -------------------------------------------
    if (rec.optOut.length > 0) {
      rec.phase = "optOutCopy";
      rec.phaseStates.optOutCopy = "running";
      await persist(id);

      for (const target of rec.optOut) {
        check();
        target.state = "running";
        rec.updatedAt = Date.now();
        await persist(id);

        const campaignId = roleId(campaigns, target.role);
        try {
          const res = await applyOptOutToCampaign({
            apiKey,
            workspaceId,
            campaignId,
          });
          target.applied = res.applied;
          target.alreadyPresent = res.alreadyPresent;
          target.state = "done";
          if (!res.verified) {
            pushError(
              rec,
              `Opt-out copy was written to "${target.name}" but the re-read didn't confirm it. Check step 1 in Plusvibe before launching.`
            );
          }
        } catch (err) {
          if (err instanceof AbortedError || m.aborted) throw err;
          target.state = "error";
          target.error = msg(err);
          pushError(rec, `Opt-out copy failed for "${target.name}": ${msg(err)}`);
        }
        rec.updatedAt = Date.now();
        await persist(id);
      }

      const anyFailed = rec.optOut.some((t) => t.state === "error");
      rec.phaseStates.optOutCopy = anyFailed ? "error" : "done";
      await persist(id);

      // A failed opt-out edit must not be papered over by moving leads into a
      // campaign that is missing its opt-out line — those leads would be sent
      // the wrong copy, and moving is the irreversible half of this job.
      if (anyFailed) {
        pushError(
          rec,
          "Stopped before moving any leads: a campaign is missing its opt-out copy, and moving leads into it would send the wrong email. Fix it in Plusvibe, then run again — the opt-out step is idempotent and the leads are untouched."
        );
        rec.status = "error";
        return;
      }
    }

    // --- Phase 3: moving leads -------------------------------------------
    rec.phase = "moving";
    rec.phaseStates.moving = "running";

    const plan = planSplit(resolution.microsoft, resolution.other);
    rec.moving.staysInSource = plan.counts.source;
    for (const t of rec.moving.targets) {
      t.planned = plan.counts[t.role];
    }
    rec.moving.plannedTotal =
      plan.counts.blue + plan.counts.blueOptOut + plan.counts.optOut;
    await persist(id);

    let sinceFlush = 0;
    for (const move of plan.moves) {
      check();
      const target = rec.moving.targets.find((t) => t.role === move.destination);
      if (!target) continue;

      if (move.leads.length === 0) {
        target.state = "done";
        continue;
      }

      target.state = "running";
      const destinationCampaignId = roleId(campaigns, move.destination);
      const payloads: LeadPayload[] = (move.leads as RawLead[])
        .map(leadToPayload)
        .filter((p) => p.email);

      let failed = false;
      for (let i = 0; i < payloads.length; i += MOVE_CHUNK) {
        check();
        const chunk = payloads.slice(i, i + MOVE_CHUNK);
        const outcome = await moveLeadChunk({
          apiKey,
          workspaceId,
          sourceCampaignId: sourceId,
          destinationCampaignId,
          chunk,
          isAborted: () => m.aborted,
        });

        if (!outcome.ok) {
          pushError(
            rec,
            `Moving leads ${i + 1}–${i + chunk.length} to "${target.name}" failed at the ${outcome.stage} step: ${outcome.reason}`
          );
          target.state = "error";
          rec.status = "error";
          failed = true;
          break;
        }

        target.moved += chunk.length;
        rec.moving.processed += chunk.length;
        rec.updatedAt = Date.now();
        if (++sinceFlush >= PERSIST_EVERY) {
          sinceFlush = 0;
          void persist(id);
        }
      }

      if (failed) break;
      target.state = "done";
      await persist(id);
    }

    if (rec.status === "running") {
      rec.status = "done";
      rec.phaseStates.moving = "done";
    } else {
      rec.phaseStates.moving = "error";
    }
  } catch (err) {
    if (err instanceof AbortedError || m.aborted) {
      rec.status = "aborted";
    } else {
      pushError(rec, msg(err));
      rec.status = "error";
      const phase = rec.phase;
      if (phase !== "finished") rec.phaseStates[phase] = "error";
    }
  } finally {
    rec.phase = "finished";
    rec.updatedAt = Date.now();
    m.apiKey = undefined;
    m.workspaceId = undefined;
    m.payload = undefined;
    await persist(id);
  }
}

// --- Query / control -------------------------------------------------------

export async function getJob(
  apiKey: string,
  id: string
): Promise<CampaignTypesJob | null> {
  await loadOnce();
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m || m.fingerprint !== fingerprintKey(apiKey)) return null;
  return rec;
}

export async function listJobs(apiKey: string): Promise<CampaignTypesJob[]> {
  await loadOnce();
  const fp = fingerprintKey(apiKey);
  const out: CampaignTypesJob[] = [];
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
