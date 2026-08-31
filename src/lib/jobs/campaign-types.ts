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
import { listCampaigns } from "@/lib/plusvibe-campaigns";
import { moveLeadChunk, MOVE_CHUNK } from "@/lib/move-leads-core";
import { resolveLeadEsps } from "@/lib/campaign-types/resolve-esp";
import { planSplit } from "@/lib/campaign-types/split";
import { applyOptOutToCampaign } from "@/lib/campaign-types/apply-opt-out";
import { duplicateCampaign, launchCampaign } from "@/lib/campaign-types/duplicate";
import { buildReuseIndex, normalizeName } from "@/lib/campaign-types/match";
import type {
  ActivationTarget,
  CampaignRole,
  CampaignTypesJob,
  CampaignTypesStartPayload,
  CreatedCampaign,
  CreatedRole,
  MoveTarget,
  PhaseState,
} from "@/lib/jobs/campaign-types-types";
import { MAX_STORED_ERRORS } from "@/lib/jobs/campaign-types-types";

// Server-side manager for Create All Campaign Types jobs.
//
// Four phases, in order:
//   1 sorting     collect the source's NOT_CONTACTED leads and split them into
//                 Microsoft / everything-else by MX lookup
//   2 duplicating create the three copies (sub-sequences included) and add the
//                 opt-out spintax to step 1 of the two Opt Out copies
//   3 moving      move each bucket into its campaign (add → verify → delete)
//   4 activating  launch all four, sub-sequences included
//
// Runs in the Node process so the work survives the tab closing, and persists
// to disk so a job can be read back later. The API key is memory-only.
//
// ONE JOB AT A TIME per API key, with the rest QUEUED behind it. The phases
// create campaigns and move leads out of a live one, so two overlapping runs
// would duplicate both and interleave the campaigns they produce. Starting a
// second job while one is going therefore queues it rather than refusing it —
// the run order is the order you pressed Start in.
//
// The queue is per API key and covers every workspace, not one lane each. Two
// workspaces running at once is safe in principle, but both would be drawing on
// the same Plusvibe rate limit, so they are taken in turn.

const JOBS_BASE = process.env.JOBS_DIR || path.join(process.cwd(), ".jobs-data");
const JOBS_DIR = path.join(JOBS_BASE, "campaign-types");
// Enough headroom for the biggest run described (20k), with slack.
const MAX_LEADS = 100_000;
const PERSIST_EVERY = 5; // flush every N chunks

interface JobMeta {
  fingerprint: string;
  apiKey?: string;
  payload?: CampaignTypesStartPayload;
  aborted: boolean;
}

const records = new Map<string, CampaignTypesJob>();
const meta = new Map<string, JobMeta>();
/** Ids waiting to run, oldest first, across every API key. */
const queue: string[] = [];
let loaded = false;

/** Stops one runaway page from stacking up an unbounded backlog. */
const MAX_QUEUED = 25;

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
  const live = (r: CampaignTypesJob) =>
    r.status === "running" || r.status === "queued";
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

/**
 * Brings a persisted record up to the current shape.
 *
 * Jobs written before this tool did its own duplication have no `created`,
 * `activation` or `sourceCampaignName`, and name their second phase
 * "optOutCopy". Rendering those crashed the whole page, so old records are
 * translated rather than trusted — and every array is defaulted, so a record
 * from any past or future shape can still be listed.
 */
function migrateRecord(raw: CampaignTypesJob): CampaignTypesJob {
  const legacy = raw as unknown as {
    campaigns?: { role: string; campaignId: string; name: string }[];
    optOut?: {
      role: string;
      name: string;
      state: PhaseState;
      applied?: string[];
      alreadyPresent?: string[];
      error?: string;
    }[];
    phaseStates?: Record<string, PhaseState>;
  };

  const rec = raw as CampaignTypesJob;
  const byRole = new Map(
    (legacy.campaigns ?? []).map((c) => [c.role, c] as const)
  );
  const legacyOptOut = new Map(
    (legacy.optOut ?? []).map((o) => [o.role, o] as const)
  );

  if (!Array.isArray(rec.created)) {
    rec.created = CREATED_ROLES.map((role) => {
      const old = byRole.get(role);
      const optOut = legacyOptOut.get(role);
      return {
        role,
        name: old?.name ?? role,
        campaignId: old?.campaignId,
        // These campaigns were made by hand back then, so they were adopted
        // rather than duplicated — "reused" is the honest label.
        reused: old ? true : undefined,
        state: old ? ("done" as PhaseState) : ("pending" as PhaseState),
        ...(OPT_OUT_ROLES.includes(role)
          ? {
              optOut: {
                state: optOut?.state ?? ("pending" as PhaseState),
                applied: optOut?.applied ?? [],
                alreadyPresent: optOut?.alreadyPresent ?? [],
                error: optOut?.error,
              },
            }
          : {}),
      };
    });
  }

  if (!rec.sourceCampaignName) {
    rec.sourceCampaignName = byRole.get("source")?.name ?? rec.label ?? "";
  }
  if (!rec.sourceCampaignId) {
    rec.sourceCampaignId = byRole.get("source")?.campaignId ?? "";
  }

  // Activation didn't exist then, so it's shown as skipped rather than pending
  // — those runs were never going to launch anything.
  if (!Array.isArray(rec.activation)) {
    rec.activation = (["source", ...CREATED_ROLES] as CampaignRole[]).map(
      (role) => ({
        role,
        name:
          role === "source"
            ? rec.sourceCampaignName
            : (rec.created.find((c) => c.role === role)?.name ?? role),
        state: "skipped" as PhaseState,
      })
    );
  }

  const ps = (legacy.phaseStates ?? {}) as Record<string, PhaseState>;
  rec.phaseStates = {
    sorting: ps.sorting ?? "pending",
    duplicating: ps.duplicating ?? ps.optOutCopy ?? "pending",
    moving: ps.moving ?? "pending",
    activating: ps.activating ?? "skipped",
  };
  if ((rec.phase as string) === "optOutCopy") rec.phase = "duplicating";

  // Everything the UI iterates, defaulted.
  rec.errors = Array.isArray(rec.errors) ? rec.errors : [];
  rec.moving = rec.moving ?? {
    targets: [],
    staysInSource: 0,
    processed: 0,
    plannedTotal: 0,
  };
  rec.moving.targets = Array.isArray(rec.moving.targets)
    ? rec.moving.targets
    : [];
  rec.sorting = rec.sorting ?? {
    leadsFound: 0,
    microsoft: 0,
    other: 0,
    domainsTotal: 0,
    domainsResolved: 0,
    unresolvedDomains: 0,
    fromLeadField: 0,
  };

  delete (rec as unknown as { campaigns?: unknown }).campaigns;
  delete (rec as unknown as { optOut?: unknown }).optOut;
  return rec;
}

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
        // A queued job is as dead as a running one across a restart: the API
        // key it needs lived only in memory, so it can never come off the
        // queue. It's marked interrupted rather than left to sit as "queued"
        // forever behind a queue that no longer exists.
        if (parsed.status === "running" || parsed.status === "queued") {
          parsed.status = "interrupted";
          parsed.updatedAt = parsed.updatedAt || Date.now();
        }
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

// --- Creation --------------------------------------------------------------

/** Raised when a job can't even be queued. */
export class QueueRejectedError extends Error {
  constructor(message: string, readonly existingJobId?: string) {
    super(message);
    this.name = "QueueRejectedError";
  }
}

function runningIdFor(fp: string): string | null {
  for (const [id, m] of meta) {
    if (m.fingerprint !== fp) continue;
    if (records.get(id)?.status === "running") return id;
  }
  return null;
}

export async function activeJob(apiKey: string): Promise<CampaignTypesJob | null> {
  await loadOnce();
  const id = runningIdFor(fingerprintKey(apiKey));
  return id ? (records.get(id) ?? null) : null;
}

function removeFromQueue(id: string) {
  const i = queue.indexOf(id);
  if (i !== -1) queue.splice(i, 1);
}

/**
 * Position of a queued job, 1 = next to run.
 *
 * Counted within the API key's own jobs, so someone else's backlog never shows
 * up in your "3rd in line".
 */
function positionOf(id: string, fp: string): number | undefined {
  let n = 0;
  for (const qid of queue) {
    if (meta.get(qid)?.fingerprint !== fp) continue;
    n += 1;
    if (qid === id) return n;
  }
  return undefined;
}

/**
 * Starts the next queued job for this API key, if nothing of theirs is running.
 *
 * Called after every start and at the end of every run, so the queue drains on
 * its own. Entries that were cancelled or deleted while waiting are skipped —
 * they're still in the array, just no longer runnable.
 */
function pump(fp: string) {
  if (runningIdFor(fp)) return;

  while (true) {
    const idx = queue.findIndex((id) => meta.get(id)?.fingerprint === fp);
    if (idx === -1) return;
    const id = queue.splice(idx, 1)[0];

    const rec = records.get(id);
    const m = meta.get(id);
    // Deleted, cancelled, or missing its key — not runnable, take the next.
    if (!rec || !m || rec.status !== "queued" || m.aborted || !m.apiKey) {
      continue;
    }

    rec.status = "running";
    rec.phase = "sorting";
    rec.phaseStates.sorting = "running";
    rec.startedAt = Date.now();
    rec.updatedAt = rec.startedAt;
    void persist(id);
    // Draining continues from here: whatever happens to this run, the next one
    // is offered its turn.
    void runJob(id).finally(() => pump(fp));
    return;
  }
}

const CREATED_ROLES: CreatedRole[] = ["blue", "optOut", "blueOptOut"];
const OPT_OUT_ROLES: CreatedRole[] = ["optOut", "blueOptOut"];

export async function createJob(
  apiKey: string,
  payload: CampaignTypesStartPayload
): Promise<string> {
  await loadOnce();
  const fp = fingerprintKey(apiKey);

  // Queueing the SAME source campaign twice is almost always a double-click or
  // a forgotten earlier press. The second run would find the three copies
  // already there and adopt them, so it wouldn't corrupt anything — but it
  // would sort and move the same leads again for no reason, and read as a
  // second batch in the list. Re-running after one finishes is still allowed;
  // this only blocks a duplicate that hasn't had its turn yet.
  for (const [otherId, m] of meta) {
    if (m.fingerprint !== fp) continue;
    const other = records.get(otherId);
    if (!other) continue;
    if (other.status !== "queued" && other.status !== "running") continue;
    if (other.sourceCampaignId !== payload.sourceCampaignId) continue;
    throw new QueueRejectedError(
      other.status === "running"
        ? `"${other.sourceCampaignName}" is being processed right now. Wait for it to finish before running it again.`
        : `"${other.sourceCampaignName}" is already waiting in the queue.`,
      otherId
    );
  }

  const waiting = queue.filter((id) => meta.get(id)?.fingerprint === fp).length;
  if (waiting >= MAX_QUEUED) {
    throw new QueueRejectedError(
      `The queue is full (${MAX_QUEUED} waiting). Let some finish before adding more.`
    );
  }

  const id = randomUUID();
  const now = Date.now();

  const created: CreatedCampaign[] = CREATED_ROLES.map((role) => ({
    role,
    name: payload.names[role],
    state: "pending" as const,
    ...(OPT_OUT_ROLES.includes(role)
      ? { optOut: { state: "pending" as const, applied: [], alreadyPresent: [] } }
      : {}),
  }));

  const moving: MoveTarget[] = CREATED_ROLES.map((role) => ({
    role,
    name: payload.names[role],
    planned: 0,
    moved: 0,
    state: "pending" as const,
  }));

  const activation: ActivationTarget[] = (
    ["source", ...CREATED_ROLES] as CampaignRole[]
  ).map((role) => ({
    role,
    name:
      role === "source"
        ? payload.sourceCampaignName
        : payload.names[role as CreatedRole],
    state: "pending" as const,
  }));

  const record: CampaignTypesJob = {
    id,
    label: payload.sourceCampaignName,
    // Always queued to begin with, even when nothing else is going: pump()
    // starts it in the same tick, so there is one path into a run rather than
    // two that could drift apart.
    status: "queued",
    phase: "sorting",
    phaseStates: {
      sorting: "pending",
      duplicating: "pending",
      moving: "pending",
      activating: payload.activate === false ? "skipped" : "pending",
    },
    createdAt: now,
    updatedAt: now,
    workspaceId: payload.workspaceId,
    workspaceName: payload.workspaceName,
    sourceCampaignId: payload.sourceCampaignId,
    sourceCampaignName: payload.sourceCampaignName,
    sorting: {
      leadsFound: 0,
      microsoft: 0,
      other: 0,
      domainsTotal: 0,
      domainsResolved: 0,
      unresolvedDomains: 0,
      fromLeadField: 0,
    },
    created,
    moving: { targets: moving, staysInSource: 0, processed: 0, plannedTotal: 0 },
    activation,
    errors: [],
  };

  records.set(id, record);
  meta.set(id, { fingerprint: fp, apiKey, payload, aborted: false });
  queue.push(id);

  await persist(id);
  pump(fp);
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
  if (!rec || !m || !m.apiKey || !m.payload) return;

  const apiKey = m.apiKey;
  const { workspaceId, sourceCampaignId } = {
    workspaceId: m.payload.workspaceId,
    sourceCampaignId: m.payload.sourceCampaignId,
  };
  const activate = m.payload.activate !== false;
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
      sourceCampaignId,
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

    // --- Phase 2: duplicating campaigns ----------------------------------
    rec.phase = "duplicating";
    rec.phaseStates.duplicating = "running";
    await persist(id);

    // Existing names in the workspace, so a resumed or repeated run adopts the
    // copies it already made instead of creating a second set under the same
    // names. Duplication is not idempotent on its own.
    //
    // Archived campaigns are excluded — see buildReuseIndex. Adopting one is
    // silently fatal: it reports as a reuse and then can't take a single lead.
    let existingByName = new Map<string, string>();
    try {
      existingByName = buildReuseIndex(await listCampaigns(apiKey, workspaceId));
    } catch (err) {
      // Without the list we can't tell a resumed run from a fresh one, and
      // duplicating blind could leave a second set of campaigns behind.
      pushError(
        rec,
        `Could not list the workspace's campaigns to check for copies already made: ${msg(err)}. Stopped before duplicating anything.`
      );
      rec.phaseStates.duplicating = "error";
      rec.status = "error";
      return;
    }

    for (const target of rec.created) {
      check();
      target.state = "running";
      rec.updatedAt = Date.now();
      await persist(id);

      // 🔵 Opt Out is duplicated from 🔵, the other two from the source.
      const from =
        target.role === "blueOptOut"
          ? rec.created.find((c) => c.role === "blue")?.campaignId
          : sourceCampaignId;

      try {
        const already = existingByName.get(normalizeName(target.name));
        if (already) {
          target.campaignId = already;
          target.reused = true;
        } else {
          if (!from) {
            throw new Error(
              "the 🔵 copy it duplicates from was not created, so there is nothing to copy"
            );
          }
          target.campaignId = await duplicateCampaign({
            apiKey,
            workspaceId,
            sourceCampaignId: from,
            newName: target.name,
          });
          existingByName.set(normalizeName(target.name), target.campaignId);
        }
        target.state = "done";
      } catch (err) {
        if (err instanceof AbortedError || m.aborted) throw err;
        target.state = "error";
        target.error = msg(err);
        pushError(rec, `Could not create "${target.name}": ${msg(err)}`);
      }
      rec.updatedAt = Date.now();
      await persist(id);
    }

    // Opt-out copy on the two Opt Out campaigns.
    for (const target of rec.created) {
      if (!target.optOut || !target.campaignId || target.state === "error") continue;
      check();
      target.optOut.state = "running";
      await persist(id);
      try {
        const res = await applyOptOutToCampaign({
          apiKey,
          workspaceId,
          campaignId: target.campaignId,
        });
        target.optOut.applied = res.applied;
        target.optOut.alreadyPresent = res.alreadyPresent;
        target.optOut.state = "done";
        if (!res.verified) {
          pushError(
            rec,
            `Opt-out copy was written to "${target.name}" but the re-read didn't confirm it. Check step 1 in Plusvibe before launching.`
          );
        }
      } catch (err) {
        if (err instanceof AbortedError || m.aborted) throw err;
        target.optOut.state = "error";
        target.optOut.error = msg(err);
        pushError(rec, `Opt-out copy failed for "${target.name}": ${msg(err)}`);
      }
      rec.updatedAt = Date.now();
      await persist(id);
    }

    const setupFailed = rec.created.some(
      (c) => c.state === "error" || c.optOut?.state === "error"
    );
    rec.phaseStates.duplicating = setupFailed ? "error" : "done";
    await persist(id);

    // Moving leads into a campaign that is missing or lacks its opt-out line
    // would send the wrong email — and the move is the irreversible half.
    if (setupFailed) {
      pushError(
        rec,
        "Stopped before moving any leads: a campaign is missing or lacks its opt-out copy. Fix it in Plusvibe, then run again — the copies already made are reused, the opt-out step is idempotent, and no leads have moved."
      );
      rec.status = "error";
      return;
    }

    // --- Phase 3: moving leads -------------------------------------------
    rec.phase = "moving";
    rec.phaseStates.moving = "running";

    const plan = planSplit(resolution.microsoft, resolution.other);
    rec.moving.staysInSource = plan.counts.source;
    for (const t of rec.moving.targets) t.planned = plan.counts[t.role];
    rec.moving.plannedTotal =
      plan.counts.blue + plan.counts.blueOptOut + plan.counts.optOut;
    await persist(id);

    let sinceFlush = 0;
    let moveFailed = false;
    for (const move of plan.moves) {
      check();
      const target = rec.moving.targets.find((t) => t.role === move.destination);
      const destinationCampaignId = rec.created.find(
        (c) => c.role === move.destination
      )?.campaignId;
      if (!target || !destinationCampaignId) continue;

      if (move.leads.length === 0) {
        target.state = "done";
        continue;
      }

      target.state = "running";
      const payloads: LeadPayload[] = (move.leads as RawLead[])
        .map(leadToPayload)
        .filter((p) => p.email);

      for (let i = 0; i < payloads.length; i += MOVE_CHUNK) {
        check();
        const chunk = payloads.slice(i, i + MOVE_CHUNK);
        const outcome = await moveLeadChunk({
          apiKey,
          workspaceId,
          sourceCampaignId,
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
          moveFailed = true;
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

      if (moveFailed) break;
      target.state = "done";
      await persist(id);
    }

    rec.phaseStates.moving = moveFailed ? "error" : "done";
    await persist(id);

    // A half-moved split must not be launched: the campaigns would start
    // sending with the wrong leads in them.
    if (moveFailed) {
      pushError(
        rec,
        "Stopped before activating: the lead split did not finish, so launching now would send from campaigns holding the wrong leads."
      );
      return;
    }

    // --- Phase 4: activating campaigns -----------------------------------
    if (!activate) {
      rec.phaseStates.activating = "skipped";
      for (const a of rec.activation) a.state = "skipped";
      rec.status = "done";
      await persist(id);
      return;
    }

    rec.phase = "activating";
    rec.phaseStates.activating = "running";
    await persist(id);

    for (const target of rec.activation) {
      check();
      const campaignId =
        target.role === "source"
          ? sourceCampaignId
          : rec.created.find((c) => c.role === target.role)?.campaignId;
      if (!campaignId) {
        target.state = "error";
        target.error = "no campaign id";
        continue;
      }
      target.state = "running";
      await persist(id);
      try {
        await launchCampaign({ apiKey, workspaceId, campaignId });
        target.state = "done";
      } catch (err) {
        if (err instanceof AbortedError || m.aborted) throw err;
        target.state = "error";
        target.error = msg(err);
        pushError(rec, `Could not activate "${target.name}": ${msg(err)}`);
      }
      rec.updatedAt = Date.now();
      await persist(id);
    }

    const activationFailed = rec.activation.some((a) => a.state === "error");
    rec.phaseStates.activating = activationFailed ? "error" : "done";
    // Everything real is done by this point — the campaigns exist, carry the
    // right copy and hold the right leads. A failed launch is a one-click fix
    // in Plusvibe, so it's reported without discarding the run.
    rec.status = activationFailed ? "error" : "done";
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
    m.payload = undefined;
    await persist(id);
  }
}

// --- Query / control -------------------------------------------------------

/**
 * Adds the live queue position, which isn't stored on the record.
 *
 * Returned as a copy so the transient number never reaches the persisted file,
 * where it would be stale the moment anything ahead of it finished.
 */
function withPosition(rec: CampaignTypesJob, fp: string): CampaignTypesJob {
  if (rec.status !== "queued") return rec;
  return { ...rec, queuePosition: positionOf(rec.id, fp) };
}

export async function getJob(
  apiKey: string,
  id: string
): Promise<CampaignTypesJob | null> {
  await loadOnce();
  const fp = fingerprintKey(apiKey);
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m || m.fingerprint !== fp) return null;
  return withPosition(rec, fp);
}

export async function listJobs(apiKey: string): Promise<CampaignTypesJob[]> {
  await loadOnce();
  const fp = fingerprintKey(apiKey);
  const out: CampaignTypesJob[] = [];
  for (const [id, m] of meta) {
    if (m.fingerprint !== fp) continue;
    const rec = records.get(id);
    if (rec) out.push(withPosition(rec, fp));
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
  // A queued job has no runner watching the aborted flag, so it is finished off
  // here. Nothing has been created for it, so this is a clean cancel rather
  // than a half-done run.
  if (rec.status === "queued") {
    removeFromQueue(id);
    rec.status = "aborted";
    rec.phase = "finished";
    rec.updatedAt = Date.now();
    m.apiKey = undefined;
    m.payload = undefined;
    await persist(id);
  }
  return true;
}

export async function deleteJob(apiKey: string, id: string): Promise<boolean> {
  await loadOnce();
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m || m.fingerprint !== fingerprintKey(apiKey)) return false;
  m.aborted = true;
  removeFromQueue(id);
  records.delete(id);
  meta.delete(id);
  try {
    await fs.unlink(fileFor(id));
  } catch {
    // already gone
  }
  return true;
}
