import "server-only";

import { createHash, randomUUID } from "crypto";
import { promises as fs, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { onShutdownFlush } from "@/lib/jobs/shutdown";
import { settleRunning } from "@/lib/jobs/settle";
import { fetchCampaignLeads, leadToPayload, type LeadPayload, type RawLead } from "@/lib/plusvibe-leads";
import { listCampaigns } from "@/lib/plusvibe-campaigns";
import { moveLeadChunk, MOVE_CHUNK } from "@/lib/move-leads-core";
import { UNMOVED_LABELS, type UnmovedLead, type UnmovedReason } from "@/lib/move-leads-plan";
import { resolveLeadEsps } from "@/lib/campaign-types/resolve-esp";
import { planSplitFor, type Availability } from "@/lib/campaign-types/split";
import { applyOptOutToCampaign } from "@/lib/campaign-types/apply-opt-out";
import { applySignatureToCampaign } from "@/lib/campaign-types/apply-signature";
import { duplicateCampaign, launchCampaign } from "@/lib/campaign-types/duplicate";
import { buildReuseIndex, matchCompanions, normalizeName } from "@/lib/campaign-types/match";
import { rolesFor, type CampaignKind } from "@/lib/campaign-types/kinds";
import { poolOf, sidesFor } from "@/lib/campaign-types/pools";
import { classifyDestinations, planAllocation, type AllocDestination } from "@/lib/campaign-types/allocate";
import { describeUnmapped, planSegmentMoves, segmentKey, segmentOf, type SegmentRule } from "@/lib/campaign-types/segments";
import { assignCampaignTag, readCampaignTags, resolvePoolTags, unassignCampaignTag } from "@/lib/campaign-types/tag-campaigns";
import type { CampaignSummary } from "@/lib/plusvibe-types";
import type {
  ActivationTarget,
  AllocActivation,
  AllocationProgress,
  CampaignRole,
  CampaignTypesJob,
  CampaignTypesMode,
  CampaignTypesStartPayload,
  CreatedCampaign,
  CreatedRole,
  MoveTarget,
  PhaseState,
  SourceInput,
  SourceRun,
  TagTarget,
} from "@/lib/jobs/campaign-types-types";
import {
  MAX_STORED_ERRORS,
  CREATED_ROLES,
  OPT_OUT_ROLES,
  SIGNATURE_ROLES,
  FROM_BLUE_ROLES,
} from "@/lib/jobs/campaign-types-types";

// Server-side manager for Create All Campaign Types jobs.
//
// Three phases, in order:
//   1 segmenting  read every original's NOT_CONTACTED leads, and move each
//                 into the original its Segment field names — so a campaign
//                 holds one segment's leads before it is copied
//   2 building    each original in turn: sort its leads by mailbox provider
//                 (Google stays plain, Microsoft and everyone else goes 🔵),
//                 duplicate the copies asked for, add the opt-out line and
//                 swap the sign-off, move each side into its campaigns
//                 (add → verify → delete), launch everything
//   3 tagging     every plain campaign is tagged google-pool, every 🔵 one
//                 microsoft-pool; the tags are created in the workspace when
//                 missing
//
// Runs in the Node process so the work survives the tab closing, and persists
// to disk so a job can be read back later. The API key is memory-only.
//
// ONE JOB AT A TIME per API key, with the rest QUEUED behind it. The phases
// create campaigns and move leads out of live ones, so two overlapping runs
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
    await fs.writeFile(fileFor(id), JSON.stringify({ ...rec, fingerprint: m.fingerprint }), "utf8");
  } catch {
    // best-effort; a failed write must not kill the run
  }
}

function flushRunningSync() {
  const live = (r: CampaignTypesJob) => r.status === "running" || r.status === "queued";
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
    // Every phase, source and target inside that was mid-way, too — or the
    // card keeps a spinner on each and the run looks as if it is still going.
    settleRunning(rec);
    rec.updatedAt = Date.now();
    try {
      writeFileSync(fileFor(id), JSON.stringify({ ...rec, fingerprint: m.fingerprint }), "utf8");
    } catch {
      // best-effort
    }
  }
}

onShutdownFlush(flushRunningSync);

const emptySorting = () => ({
  leadsFound: 0,
  microsoft: 0,
  google: 0,
  other: 0,
  domainsTotal: 0,
  domainsResolved: 0,
  unresolvedDomains: 0,
  fromLeadField: 0,
});

const emptyMoving = () => ({ targets: [], staysInSource: 0, processed: 0, plannedTotal: 0 });

/**
 * Brings a persisted record up to the current shape.
 *
 * Records from before this tool took several originals at once have one
 * source spread over the record itself — sorting, created, moving,
 * activation and a four-step phase — and no segment or tagging phase. They
 * are folded into a single-entry `sources` with the two new phases skipped.
 * Older still are records from before the tool did its own duplication.
 * Rendering those crashed the whole page, so old records are translated
 * rather than trusted — and every array is defaulted, so a record from any
 * past or future shape can still be listed.
 */
function migrateRecord(raw: CampaignTypesJob): CampaignTypesJob {
  const legacy = raw as unknown as {
    sourceCampaignId?: string;
    sourceCampaignName?: string;
    sorting?: SourceRun["sorting"];
    created?: CreatedCampaign[];
    moving?: SourceRun["moving"];
    activation?: ActivationTarget[];
    phase?: string;
    phaseStates?: Record<string, PhaseState>;
    campaigns?: { role: string; campaignId: string; name: string }[];
    optOut?: { role: string; name: string; state: PhaseState; applied?: string[]; alreadyPresent?: string[]; error?: string }[];
  };
  const rec = raw as CampaignTypesJob;

  if (!Array.isArray(rec.sources)) {
    // A single-source record: fold it into sources[0].
    const byRole = new Map((legacy.campaigns ?? []).map((c) => [c.role, c] as const));
    const legacyOptOut = new Map((legacy.optOut ?? []).map((o) => [o.role, o] as const));
    const created: CreatedCampaign[] = Array.isArray(legacy.created)
      ? legacy.created
      : CREATED_ROLES.map((role) => {
          const old = byRole.get(role);
          const optOut = legacyOptOut.get(role);
          return {
            role,
            name: old?.name ?? role,
            campaignId: old?.campaignId,
            // Made by hand back then, so adopted rather than duplicated.
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
    const sourceName = legacy.sourceCampaignName || byRole.get("source")?.name || rec.label || "";
    const sourceId = legacy.sourceCampaignId || byRole.get("source")?.campaignId || "";
    const ps = (legacy.phaseStates ?? {}) as Record<string, PhaseState>;
    const oldPhase = legacy.phase === "optOutCopy" ? "duplicating" : legacy.phase;
    const sourcePhase = (["sorting", "duplicating", "moving", "activating", "finished"] as const).find((p) => p === oldPhase) ?? "finished";
    const phaseStates = {
      sorting: ps.sorting ?? "pending",
      duplicating: ps.duplicating ?? ps.optOutCopy ?? "pending",
      moving: ps.moving ?? "pending",
      activating: ps.activating ?? "skipped",
    };
    const activation: ActivationTarget[] = Array.isArray(legacy.activation)
      ? legacy.activation
      : (["source", ...CREATED_ROLES] as CampaignRole[]).map((role) => ({
          role,
          name: role === "source" ? sourceName : (created.find((c) => c.role === role)?.name ?? role),
          state: "skipped" as PhaseState,
        }));
    const moving = legacy.moving ?? emptyMoving();
    moving.targets = Array.isArray(moving.targets) ? moving.targets : [];
    const anyError = Object.values(phaseStates).includes("error");
    rec.sources = [
      {
        campaignId: sourceId,
        campaignName: sourceName,
        state: rec.status === "done" ? "done" : anyError || rec.status === "error" ? "error" : rec.status === "running" ? "running" : "pending",
        phase: sourcePhase,
        phaseStates,
        sorting: legacy.sorting ?? emptySorting(),
        created,
        moving,
        activation,
      },
    ];
    const building: PhaseState = Object.values(phaseStates).every((s) => s === "pending")
      ? "pending"
      : anyError
        ? "error"
        : rec.status === "running"
          ? "running"
          : "done";
    rec.phaseStates = { segmenting: "skipped", building, tagging: "skipped" };
    rec.phase = rec.status === "running" || rec.status === "queued" ? "building" : "finished";
    rec.kinds = ["default", "optOut", "signature"];
    for (const k of ["sourceCampaignId", "sourceCampaignName", "sorting", "created", "moving", "activation", "settings", "campaigns", "optOut"]) {
      delete (rec as unknown as Record<string, unknown>)[k];
    }
  }

  // Everything the UI iterates, defaulted.
  rec.errors = Array.isArray(rec.errors) ? rec.errors : [];
  rec.sources = rec.sources.map((s) => ({
    ...s,
    sorting: s.sorting ?? emptySorting(),
    created: Array.isArray(s.created) ? s.created : [],
    moving: { ...(s.moving ?? emptyMoving()), targets: Array.isArray(s.moving?.targets) ? s.moving.targets : [] },
    activation: Array.isArray(s.activation) ? s.activation : [],
    phaseStates: s.phaseStates ?? { sorting: "pending", duplicating: "pending", moving: "pending", activating: "pending" },
  }));
  rec.segmenting = rec.segmenting ?? { rules: [], leadsFound: 0, stayed: 0, unmapped: 0, unmappedSegments: [], plannedTotal: 0, processed: 0, moved: 0 };
  rec.segmenting.rules = Array.isArray(rec.segmenting.rules) ? rec.segmenting.rules : [];
  rec.tagging = rec.tagging ?? { targets: [], tagsCreated: [] };
  rec.tagging.targets = Array.isArray(rec.tagging.targets) ? rec.tagging.targets : [];
  rec.kinds = Array.isArray(rec.kinds) ? rec.kinds : ["default", "optOut", "signature"];
  rec.phaseStates = rec.phaseStates ?? { segmenting: "pending", building: "pending", tagging: "pending" };
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
        const parsed = JSON.parse(raw) as CampaignTypesJob & { fingerprint?: string };
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
        // Nothing is running at load, so nothing inside may say it is. This
        // also mends records saved before the shutdown settled them, which is
        // every interrupted run written before this line existed.
        settleRunning(parsed);
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
  constructor(
    message: string,
    readonly existingJobId?: string
  ) {
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
    if (!rec || !m || rec.status !== "queued" || m.aborted || !m.apiKey) continue;

    rec.status = "running";
    rec.startedAt = Date.now();
    rec.updatedAt = rec.startedAt;
    void persist(id);
    // Draining continues from here: whatever happens to this run, the next one
    // is offered its turn.
    void runJob(id).finally(() => pump(fp));
    return;
  }
}

/** "🟡 A (August)", or "🟡 A (August) + 2 more". */
export function labelFor(sources: { campaignName: string }[]): string {
  if (sources.length === 0) return "";
  const first = sources[0].campaignName;
  return sources.length === 1 ? first : `${first} + ${sources.length - 1} more`;
}

function newSourceRun(src: SourceInput, roles: CreatedRole[], mode: "create" | "move", activate: boolean): SourceRun {
  // A move run edits no copy: the campaigns it finds already carry their
  // opt-out line and sign-off, and touching them again is not its business.
  const created: CreatedCampaign[] = roles.map((role) => ({
    role,
    name: src.names[role],
    state: "pending" as const,
    ...(mode === "create" && OPT_OUT_ROLES.includes(role) ? { optOut: { state: "pending" as const, applied: [], alreadyPresent: [] } } : {}),
    ...(mode === "create" && SIGNATURE_ROLES.includes(role)
      ? { signature: { state: "pending" as const, applied: [], alreadyPresent: [], missing: [] } }
      : {}),
  }));
  const moving: MoveTarget[] = roles.map((role) => ({ role, name: src.names[role], planned: 0, moved: 0, state: "pending" as const }));
  const activation: ActivationTarget[] = activate
    ? (["source", ...roles] as CampaignRole[]).map((role) => ({
        role,
        name: role === "source" ? src.campaignName : src.names[role as CreatedRole],
        state: "pending" as const,
      }))
    : [];
  return {
    campaignId: src.campaignId,
    campaignName: src.campaignName,
    state: "pending",
    phase: "sorting",
    phaseStates: {
      sorting: "pending",
      duplicating: "pending",
      moving: "pending",
      // A move run launches nothing: the campaigns it moves into are already
      // running, and resuming a paused one is the user's decision.
      activating: activate ? "pending" : "skipped",
    },
    sorting: emptySorting(),
    created,
    moving: { targets: moving, staysInSource: 0, processed: 0, plannedTotal: 0 },
    activation,
  };
}

export async function createJob(apiKey: string, payload: CampaignTypesStartPayload): Promise<string> {
  await loadOnce();
  const fp = fingerprintKey(apiKey);

  // Queueing the SAME original twice is almost always a double-click or a
  // forgotten earlier press. The second run would find the copies already
  // there and adopt them, so it wouldn't corrupt anything — but it would sort
  // and move the same leads again for no reason, and read as a second batch
  // in the list. Re-running after one finishes is still allowed; this only
  // blocks a duplicate that hasn't had its turn yet.
  const wanted = new Set(payload.sources.map((s) => s.campaignId));
  for (const [otherId, m] of meta) {
    if (m.fingerprint !== fp) continue;
    const other = records.get(otherId);
    if (!other) continue;
    if (other.status !== "queued" && other.status !== "running") continue;
    const clash = other.sources.find((s) => wanted.has(s.campaignId));
    if (!clash) continue;
    throw new QueueRejectedError(
      other.status === "running"
        ? `"${clash.campaignName}" is being processed right now. Wait for it to finish before running it again.`
        : `"${clash.campaignName}" is already waiting in the queue.`,
      otherId
    );
  }

  const waiting = queue.filter((id) => meta.get(id)?.fingerprint === fp).length;
  if (waiting >= MAX_QUEUED) {
    throw new QueueRejectedError(`The queue is full (${MAX_QUEUED} waiting). Let some finish before adding more.`);
  }

  const id = randomUUID();
  const now = Date.now();
  const mode: CampaignTypesMode =
    payload.mode === "move" ? "move" : payload.mode === "fix" ? "fix" : "create";
  const activate = mode === "create" && payload.activate !== false;
  const roles = rolesFor(payload.kinds);

  const record: CampaignTypesJob = {
    id,
    label: labelFor(payload.sources),
    mode,
    // Always queued to begin with, even when nothing else is going: pump()
    // starts it in the same tick, so there is one path into a run rather than
    // two that could drift apart.
    status: "queued",
    phase: "segmenting",
    phaseStates: {
      segmenting: payload.rules.length > 0 ? "pending" : "skipped",
      building: "pending",
      tagging: "pending",
    },
    createdAt: now,
    updatedAt: now,
    workspaceId: payload.workspaceId,
    workspaceName: payload.workspaceName,
    kinds: payload.kinds,
    segmenting: {
      rules: payload.rules.map((r) => ({ ...r, planned: 0, moved: 0, state: "pending" as const })),
      leadsFound: 0,
      stayed: 0,
      unmapped: 0,
      unmappedSegments: [],
      plannedTotal: 0,
      processed: 0,
      moved: 0,
    },
    sources: payload.sources.map((s) => newSourceRun(s, roles, mode === "create" ? "create" : "move", activate)),
    // A fix run keeps its own progress: the sources are read and nothing else,
    // so none of a SourceRun's phases apply to them.
    ...(mode === "fix"
      ? {
          allocation: {
            segment: (payload.segment ?? "").trim(),
            sources: payload.sources.map((s) => ({
              campaignId: s.campaignId,
              campaignName: s.campaignName,
              leads: 0,
            })),
            destinations: classifyDestinations(payload.destinations ?? []).destinations.map((d) => ({
              campaignId: d.campaignId,
              campaignName: d.campaignName,
              role: d.role,
              planned: 0,
              moved: 0,
              unmoved: 0,
            })),
            leadsFound: 0,
            matched: 0,
            stranded: 0,
            moved: 0,
            state: "pending" as const,
          },
        }
      : {}),
    tagging: { targets: [], tagsCreated: [] },
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function msg(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

function pushError(rec: CampaignTypesJob, text: string) {
  if (rec.errors.length < MAX_STORED_ERRORS) rec.errors.push(text);
  else rec.errorsTruncated = true;
}

/** What one run's helpers share. */
interface RunCtx {
  id: string;
  rec: CampaignTypesJob;
  m: JobMeta;
  apiKey: string;
  workspaceId: string;
  check: () => void;
  /** Plusvibe's lead quota was reached; every further add would be refused. */
  quotaHit: boolean;
  sinceFlush: number;
}

interface MoveResult {
  moved: number;
  unmoved: UnmovedLead[];
  /** Chunks that landed in the destination but could not be deleted from the source. */
  inBoth: number;
}

/**
 * Moves leads from one campaign into another, chunk by chunk, the way the
 * split has always done it: a failed add is retried once, a lead Plusvibe
 * turns away is named and left where it was, and a chunk that cannot be
 * deleted from the source is counted as moved (the destination has it) and
 * flagged. Nothing here stops the run.
 */
async function moveInto(
  ctx: RunCtx,
  opts: { from: string; to: string; toName: string; leads: RawLead[]; onProgress: (n: number) => void }
): Promise<MoveResult> {
  const { rec, m, apiKey, workspaceId, check } = ctx;
  const result: MoveResult = { moved: 0, unmoved: [], inBoth: 0 };
  const payloads: LeadPayload[] = opts.leads.map(leadToPayload).filter((p) => p.email);

  for (let i = 0; i < payloads.length; i += MOVE_CHUNK) {
    check();
    const chunk = payloads.slice(i, i + MOVE_CHUNK);
    const range = `${i + 1}–${i + chunk.length}`;

    if (ctx.quotaHit) {
      // The plan is full; every further add would be turned away.
      result.unmoved.push(...chunk.map((c) => ({ email: c.email, reason: "overflow" as UnmovedReason })));
      opts.onProgress(chunk.length);
      continue;
    }

    const attempt = () =>
      moveLeadChunk({
        apiKey,
        workspaceId,
        sourceCampaignId: opts.from,
        destinationCampaignId: opts.to,
        chunk,
        isAborted: () => m.aborted,
      });
    let outcome = await attempt();
    // A failed add changed nothing, so it gets one more go after a pause:
    // the usual cause is a passing 5xx or a rate-limit hiccup.
    if (!outcome.ok && outcome.stage === "add" && outcome.reason !== "aborted") {
      await sleep(2000);
      check();
      outcome = await attempt();
    }

    if (!outcome.ok) {
      if (outcome.reason === "aborted") throw new AbortedError();
      if (outcome.stage === "delete") {
        // In the destination, and still in the source. Counted as moved —
        // the destination has them — and flagged for cleaning up.
        pushError(rec, `Moving leads ${range} to "${opts.toName}": ${outcome.reason}`);
        result.moved += chunk.length;
        result.inBoth += chunk.length;
      } else {
        pushError(rec, `Moving leads ${range} to "${opts.toName}" failed twice at the add step: ${outcome.reason}. Those leads stayed where they were.`);
        result.unmoved.push(
          ...outcome.unmoved,
          ...chunk
            .filter((c) => !outcome.unmoved.some((u) => u.email === c.email))
            .map((c) => ({ email: c.email, reason: "add-failed" as UnmovedReason }))
        );
      }
    } else {
      result.moved += outcome.deleted;
      result.unmoved.push(...outcome.unmoved);
      if (outcome.quotaHit) {
        ctx.quotaHit = true;
        pushError(
          rec,
          `Plusvibe's lead quota was reached while moving to "${opts.toName}". The leads it turned away stayed where they were, and the rest of the moves were skipped; they can be moved once there is room.`
        );
      }
    }

    opts.onProgress(chunk.length);
    rec.updatedAt = Date.now();
    if (++ctx.sinceFlush >= PERSIST_EVERY) {
      ctx.sinceFlush = 0;
      void persist(ctx.id);
    }
  }
  return result;
}

/** "3 duplicate address in the batch, 1 not a valid email address" */
function describeReasons(reasons: Record<string, number>): string {
  return Object.entries(reasons)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${n} ${UNMOVED_LABELS[reason as UnmovedReason] ?? reason}`)
    .join(", ");
}

function countReasons(list: UnmovedLead[], into: Record<string, number>) {
  for (const u of list) into[u.reason] = (into[u.reason] ?? 0) + 1;
}

// --- Fix Allocation: putting leads where they should have gone ----------------
//
// Reads the campaigns it is given, takes the leads carrying one segment, and
// moves them into campaigns picked by hand. The sources are only ever read:
// no names are derived from them and nothing is moved into them, which is what
// makes it safe to name a copy here.

async function runFixAllocation(ctx: RunCtx, payload: CampaignTypesStartPayload) {
  const { rec, apiKey, workspaceId, check, id } = ctx;
  const alloc = rec.allocation;
  if (!alloc) return;
  rec.phase = "segmenting";
  rec.phaseStates = { segmenting: "running", building: "skipped", tagging: "skipped" };
  await persist(id);

  // 1. Read every source. A lead moved out of one must not be read again out
  //    of another, so the whole snapshot is taken before anything moves.
  const snapshot: { campaignId: string; campaignName: string; leads: RawLead[] }[] = [];
  for (const src of alloc.sources) {
    check();
    let leads: RawLead[] = [];
    try {
      const got = await fetchCampaignLeads(apiKey, workspaceId, src.campaignId, MAX_LEADS);
      leads = got.leads;
      if (got.hitPageLimit) {
        pushError(rec, `Stopped collecting "${src.campaignName}" at ${leads.length} leads — the paging budget ran out. Run again for the rest.`);
      }
      if (got.wrongStatus > 0) {
        pushError(rec, `${got.wrongStatus} lead(s) of "${src.campaignName}" are past NOT_CONTACTED and were left alone.`);
      }
    } catch (err) {
      if (err instanceof AbortedError || ctx.m.aborted) throw err;
      pushError(rec, `Could not read "${src.campaignName}": ${msg(err)}. Nothing was taken from it.`);
    }
    src.leads = leads.length;
    alloc.leadsFound += leads.length;
    snapshot.push({ campaignId: src.campaignId, campaignName: src.campaignName, leads });
    rec.updatedAt = Date.now();
    await persist(id);
  }
  check();

  // 2. Plan, per source, so each move knows where its leads came from — the
  //    move is an add to the destination and then a delete from the source.
  const destinations = alloc.destinations.map(
    (d) => ({ campaignId: d.campaignId, campaignName: d.campaignName, role: d.role }) as AllocDestination
  );
  for (const src of snapshot) {
    check();
    // Which side each lead is on, the same way a normal run decides it: by
    // resolving the sending domain, not by trusting a field on the lead.
    const resolution = await resolveLeadEsps(src.leads, { isAborted: () => ctx.m.aborted });
    const plan = planAllocation(
      resolution.classified.map(({ lead, esp }) => ({
        lead,
        segment: segmentOf(lead),
        blue: esp !== "GOOGLE",
      })),
      alloc.segment,
      destinations
    );
    alloc.matched += plan.matched;
    alloc.stranded += plan.stranded;
    for (const mv of plan.moves) {
      const d = alloc.destinations.find((x) => x.campaignId === mv.campaignId);
      if (d) d.planned += mv.leads.length;
    }
    await persist(id);

    for (const mv of plan.moves) {
      check();
      if (mv.leads.length === 0) continue;
      const res = await moveInto(ctx, {
        from: src.campaignId,
        to: mv.campaignId,
        toName: mv.campaignName,
        leads: mv.leads,
        onProgress: () => undefined,
      });
      const d = alloc.destinations.find((x) => x.campaignId === mv.campaignId);
      if (d) {
        d.moved += res.moved;
        d.unmoved += res.unmoved.length;
      }
      alloc.moved += res.moved;
      if (res.unmoved.length > 0) {
        const reasons: Record<string, number> = {};
        countReasons(res.unmoved, reasons);
        pushError(
          rec,
          `${res.unmoved.length} lead(s) of "${src.campaignName}" did not reach "${mv.campaignName}": ${describeReasons(reasons)}. They are still in "${src.campaignName}".`
        );
      }
      rec.updatedAt = Date.now();
      await persist(id);
    }
  }

  if (alloc.stranded > 0) {
    pushError(
      rec,
      `${alloc.stranded} lead(s) carry "${alloc.segment}" but no campaign was picked for their side, so they stayed where they were. Pick one for every side you want filled.`
    );
  }
  if (alloc.matched === 0) {
    pushError(
      rec,
      `No lead in the campaigns read carries the segment "${alloc.segment}". Check the spelling against the leads — it is matched exactly, bar case and spaces.`
    );
  }
  // 3. Every campaign it touched, running. A source emptied of the segment
  //    and a destination that was a draft both need launching before a single
  //    email goes out, and having to find and start each one in Plusvibe by
  //    hand is exactly the step that gets forgotten.
  await activateAllocation(ctx, alloc);

  alloc.state = "done";
  rec.phaseStates.segmenting = "done";
  rec.updatedAt = Date.now();
  await persist(id);
}

/** What Plusvibe calls a campaign that is sending. */
function isRunning(status: string | undefined): boolean {
  const s = (status ?? "").trim().toUpperCase();
  return s === "ACTIVE" || s === "RUNNING";
}

/**
 * Checks every source and destination, launches the ones not running, and
 * reads them back to be sure. A campaign that cannot be launched is reported
 * by name with Plusvibe's own reason — most often an empty campaign, which
 * Plusvibe refuses to start — and never undoes the moves: the leads are where
 * they belong either way, and a launch is one click in Plusvibe.
 */
async function activateAllocation(ctx: RunCtx, alloc: AllocationProgress) {
  const { rec, apiKey, workspaceId, check, id } = ctx;
  const list: AllocActivation[] = [];
  const seen = new Set<string>();
  const add = (c: { campaignId: string; campaignName: string }, side: AllocActivation["side"]) => {
    if (!c.campaignId || seen.has(c.campaignId)) return;
    seen.add(c.campaignId);
    list.push({ campaignId: c.campaignId, campaignName: c.campaignName, side, state: "pending" });
  };
  for (const s of alloc.sources) add(s, "source");
  for (const d of alloc.destinations) add(d, "destination");
  alloc.activation = list;
  await persist(id);

  // Status straight from the workspace, not from when the run was set up: a
  // campaign may have been paused or launched by hand in the meantime.
  const statuses = async () => {
    const all = await listCampaigns(apiKey, workspaceId, { campaignType: "all" });
    return new Map(all.map((c) => [c.id, c.status]));
  };

  let before: Map<string, string>;
  try {
    check();
    before = await statuses();
  } catch (err) {
    if (err instanceof AbortedError || ctx.m.aborted) throw err;
    for (const a of list) {
      a.state = "error";
      a.error = "status could not be read";
    }
    pushError(rec, `The leads moved, but the campaigns' status could not be read to activate them: ${msg(err)}. Check each one is active in Plusvibe.`);
    await persist(id);
    return;
  }

  for (const a of list) {
    check();
    a.before = before.get(a.campaignId);
    if (isRunning(a.before)) {
      a.after = a.before;
      a.state = "done";
      continue;
    }
    if (a.before === undefined) {
      a.state = "error";
      a.error = "not found in the workspace";
      continue;
    }
    if (a.before === "ARCHIVED") {
      a.state = "error";
      a.error = "archived — unarchive it in Plusvibe before it can run";
      continue;
    }
    a.state = "running";
    await persist(id);
    try {
      await launchCampaign({ apiKey, workspaceId, campaignId: a.campaignId });
      a.launched = true;
    } catch (err) {
      if (err instanceof AbortedError || ctx.m.aborted) throw err;
      a.state = "error";
      a.error = msg(err);
    }
    rec.updatedAt = Date.now();
    await persist(id);
  }

  // A launch that answered "success" is not taken on its word: the status is
  // read again, and only ACTIVE counts.
  const launched = list.filter((a) => a.launched);
  if (launched.length > 0) {
    let after: Map<string, string> | null = null;
    try {
      check();
      after = await statuses();
    } catch (err) {
      if (err instanceof AbortedError || ctx.m.aborted) throw err;
      pushError(rec, `Launched ${launched.length} campaign${launched.length === 1 ? "" : "s"}, but could not read the status back to confirm: ${msg(err)}. Check them in Plusvibe.`);
    }
    for (const a of launched) {
      if (!after) {
        a.state = "done";
        continue;
      }
      a.after = after.get(a.campaignId);
      if (isRunning(a.after)) a.state = "done";
      else {
        a.state = "error";
        a.error = `launched, but it reads ${a.after ?? "missing"} afterwards`;
      }
    }
  }

  for (const a of list) {
    if (a.state !== "error") continue;
    pushError(rec, `"${a.campaignName}" is not active: ${a.error}. Its leads are in place; launch it in Plusvibe once that is sorted.`);
  }
  rec.updatedAt = Date.now();
  await persist(id);
}

// --- Phase 1: sorting by segment ---------------------------------------------

async function runSegmenting(ctx: RunCtx, rules: SegmentRule[]) {
  const { rec, apiKey, workspaceId, check, id } = ctx;
  const seg = rec.segmenting;
  rec.phase = "segmenting";
  rec.phaseStates.segmenting = "running";
  await persist(id);

  // Every original's leads first, then the plan: a lead moved from A to B
  // must not be read again out of B and sent somewhere else.
  const snapshot: { campaignId: string; leads: RawLead[] }[] = [];
  for (const src of rec.sources) {
    check();
    const { leads, hitPageLimit, wrongStatus } = await fetchCampaignLeads(apiKey, workspaceId, src.campaignId, MAX_LEADS);
    if (hitPageLimit) {
      pushError(rec, `Stopped collecting "${src.campaignName}" at ${leads.length} leads — the paging budget ran out before the campaign did. Run again for the rest.`);
    }
    if (wrongStatus > 0) {
      pushError(rec, `${wrongStatus} lead(s) of "${src.campaignName}" came back with a status other than NOT_CONTACTED and were skipped.`);
    }
    snapshot.push({ campaignId: src.campaignId, leads });
    seg.leadsFound += leads.length;
    rec.updatedAt = Date.now();
    await persist(id);
  }
  check();

  const plan = planSegmentMoves(snapshot, rules);
  seg.stayed = plan.counts.stayed;
  seg.unmapped = plan.counts.unmapped;
  seg.unmappedSegments = plan.counts.unmappedSegments;
  seg.plannedTotal = plan.counts.planned;
  for (const r of seg.rules) {
    const planned = plan.counts.perRule.find((p) => p.campaignId === r.campaignId && segmentKey(p.segment) === segmentKey(r.segment));
    r.planned = planned?.planned ?? 0;
    if (r.planned === 0) r.state = "done";
  }
  if (seg.unmapped > 0) {
    pushError(rec, describeUnmapped(seg.unmapped, seg.unmappedSegments, seg.rules));
  }
  await persist(id);

  const reasons: Record<string, number> = {};
  let problems = false;
  for (const move of plan.moves) {
    check();
    const rule = seg.rules.find((r) => r.campaignId === move.toCampaignId && segmentKey(r.segment) === segmentKey(move.segment));
    if (rule) rule.state = "running";
    const res = await moveInto(ctx, {
      from: move.fromCampaignId,
      to: move.toCampaignId,
      toName: move.toCampaignName,
      leads: move.leads,
      onProgress: (n) => {
        seg.processed += n;
      },
    });
    seg.moved += res.moved;
    if (rule) rule.moved += res.moved;
    if (res.unmoved.length > 0) {
      countReasons(res.unmoved, reasons);
      seg.unmoved = (seg.unmoved ?? 0) + res.unmoved.length;
      seg.unmovedReasons = { ...reasons };
      if (rule) rule.unmoved = (rule.unmoved ?? 0) + res.unmoved.length;
      problems = true;
    }
    if (res.inBoth > 0) problems = true;
    await persist(id);
  }
  for (const r of seg.rules) if (r.state !== "done") r.state = (r.unmoved ?? 0) > 0 ? "error" : "done";
  if ((seg.unmoved ?? 0) > 0) {
    pushError(rec, `${seg.unmoved} lead${seg.unmoved === 1 ? "" : "s"} could not be moved to their segment's campaign: ${describeReasons(reasons)}. They were not deleted from anywhere.`);
  }
  rec.phaseStates.segmenting = problems ? "error" : "done";
  rec.updatedAt = Date.now();
  await persist(id);
}

// --- Phase 2: one original at a time ------------------------------------------

async function runSource(
  ctx: RunCtx,
  src: SourceRun,
  opts: { mode: "create" | "move"; activate: boolean; existingByName: Map<string, string>; workspaceCampaigns: CampaignSummary[]; roles: CreatedRole[] }
) {
  const { rec, m, apiKey, workspaceId, check, id } = ctx;
  const { mode, activate, existingByName, workspaceCampaigns } = opts;
  const sourceCampaignId = src.campaignId;
  // With several originals, every message says which one it is about.
  const who = rec.sources.length > 1 ? `${src.campaignName}: ` : "";
  src.state = "running";

  // --- sorting leads by provider ------------------------------------------
  src.phase = "sorting";
  src.phaseStates.sorting = "running";
  await persist(id);

  const { leads, wrongStatus, hitPageLimit } = await fetchCampaignLeads(apiKey, workspaceId, sourceCampaignId, MAX_LEADS);
  check();
  src.sorting.leadsFound = leads.length;
  src.sorting.hitPageLimit = hitPageLimit;
  if (hitPageLimit) {
    pushError(rec, `${who}Stopped collecting at ${leads.length} leads — the paging budget ran out before the campaign did. Those collected are still split and moved; run again for the rest.`);
  }
  if (wrongStatus > 0) {
    pushError(rec, `${who}${wrongStatus} lead(s) came back with a status other than NOT_CONTACTED and were skipped — the API's status filter appears not to be applied. Nothing already-contacted was moved.`);
  }
  await persist(id);

  const resolution = await resolveLeadEsps(leads, {
    isAborted: () => m.aborted,
    onProgress: (done, total) => {
      src.sorting.domainsResolved = done;
      src.sorting.domainsTotal = total;
      rec.updatedAt = Date.now();
    },
  });
  check();
  const sides = sidesFor(resolution.classified);
  src.sorting.microsoft = resolution.counts.microsoft;
  src.sorting.google = resolution.counts.google;
  src.sorting.other = resolution.counts.other;
  src.sorting.unresolvedDomains = resolution.unresolvedDomains.length;
  src.sorting.fromLeadField = resolution.fromLeadField;
  src.sorting.domainsTotal = resolution.domainsLookedUp;
  src.sorting.domainsResolved = resolution.domainsLookedUp;
  if (resolution.unresolvedDomains.length > 0) {
    pushError(
      rec,
      `${who}${resolution.unresolvedDomains.length} domain(s) could not be resolved (e.g. ${resolution.unresolvedDomains.slice(0, 5).join(", ")}). Their leads were treated as neither Microsoft nor Google, which puts them in the 🔵 campaigns.`
    );
  }
  src.phaseStates.sorting = "done";
  await persist(id);

  // --- duplicating (move: finding) -------------------------------------------
  src.phase = "duplicating";
  src.phaseStates.duplicating = "running";
  await persist(id);

  if (mode === "move") {
    // Nothing is created here: the copies were made by an earlier run and are
    // found by name among the live ones. A name that isn't there, or that two
    // campaigns share, is skipped — its share stays with the others in its
    // pool — so the run never guesses which campaign was meant.
    const found = matchCompanions(src.campaignName, workspaceCampaigns, sourceCampaignId, opts.roles);
    for (const target of src.created) {
      const hit = found.matches.find((x) => x.role === target.role);
      if (hit?.match) {
        target.campaignId = hit.match.id;
        target.reused = true;
        target.state = "done";
        // The stored name, not the derived one: that is the campaign the
        // leads actually go to, and both the card and any error should say so.
        target.name = hit.match.name;
        const mv = src.moving.targets.find((t) => t.role === target.role);
        if (mv) mv.name = hit.match.name;
        if (hit.loose) pushError(rec, `${who}"${hit.match.name}" was matched to "${hit.expectedName}" by ignoring separators. Check it is the right campaign.`);
      } else {
        target.state = "skipped";
        target.error = hit?.ambiguous ? "more than one campaign has this name" : "no campaign with this name";
        const mv = src.moving.targets.find((t) => t.role === target.role);
        if (mv) mv.state = "skipped";
        pushError(
          rec,
          hit?.ambiguous
            ? `${who}More than one campaign is called "${target.name}", so there is no telling which was meant. Nothing was moved into it.`
            : `${who}No campaign called "${target.name}" in this workspace, so its share went to the other campaigns in its pool.`
        );
      }
    }
    if (!src.created.some((c) => c.campaignId)) {
      pushError(rec, `${who}None of its copies are in this workspace, so there is nowhere to move anything. Check the names in Plusvibe, and that they are not archived.`);
      src.phaseStates.duplicating = "error";
      src.state = "error";
      return;
    }
    rec.updatedAt = Date.now();
    await persist(id);
  }

  for (const target of src.created) {
    if (mode === "move") break;
    check();
    target.state = "running";
    rec.updatedAt = Date.now();
    await persist(id);

    // The 🔵 copies are duplicated from 🔵 when there is one, else from the
    // source — the two are the same campaign apart from the name.
    const blueId = src.created.find((c) => c.role === "blue")?.campaignId;
    const from = FROM_BLUE_ROLES.includes(target.role) && blueId ? blueId : sourceCampaignId;

    try {
      const already = existingByName.get(normalizeName(target.name));
      if (already) {
        target.campaignId = already;
        target.reused = true;
      } else {
        target.campaignId = await duplicateCampaign({ apiKey, workspaceId, sourceCampaignId: from, newName: target.name });
        existingByName.set(normalizeName(target.name), target.campaignId);
      }
      target.state = "done";
    } catch (err) {
      if (err instanceof AbortedError || m.aborted) throw err;
      target.state = "error";
      target.error = msg(err);
      pushError(rec, `${who}Could not create "${target.name}": ${msg(err)}`);
    }
    rec.updatedAt = Date.now();
    await persist(id);
  }

  // Opt-out copy on the Opt Out campaigns.
  for (const target of src.created) {
    if (!target.optOut || !target.campaignId || target.state === "error") continue;
    check();
    target.optOut.state = "running";
    await persist(id);
    try {
      const res = await applyOptOutToCampaign({ apiKey, workspaceId, campaignId: target.campaignId });
      target.optOut.applied = res.applied;
      target.optOut.alreadyPresent = res.alreadyPresent;
      target.optOut.state = "done";
      if (!res.verified) pushError(rec, `${who}Opt-out copy was written to "${target.name}" but the re-read didn't confirm it. Check step 1 in Plusvibe before launching.`);
    } catch (err) {
      if (err instanceof AbortedError || m.aborted) throw err;
      target.optOut.state = "error";
      target.optOut.error = msg(err);
      pushError(rec, `${who}Opt-out copy failed for "${target.name}": ${msg(err)}`);
    }
    rec.updatedAt = Date.now();
    await persist(id);
  }

  // Sign-off swap on the Signature campaigns.
  for (const target of src.created) {
    if (!target.signature || !target.campaignId || target.state === "error") continue;
    check();
    target.signature.state = "running";
    await persist(id);
    try {
      const res = await applySignatureToCampaign({ apiKey, workspaceId, campaignId: target.campaignId });
      target.signature.applied = res.applied;
      target.signature.alreadyPresent = res.alreadyPresent;
      target.signature.missing = res.missing;
      target.signature.state = "done";
      if (res.missing.length > 0) {
        pushError(
          rec,
          `${who}Step 1 variation(s) ${res.missing.join(", ")} of "${target.name}" carry neither {{sender_first_name}} nor {{sender_signature}}, so nothing was swapped on them. They will send exactly as the source does.`
        );
      }
      if (!res.verified) pushError(rec, `${who}The sign-off was swapped on "${target.name}" but the re-read didn't confirm it. Check step 1 in Plusvibe before launching.`);
    } catch (err) {
      if (err instanceof AbortedError || m.aborted) throw err;
      target.signature.state = "error";
      target.signature.error = msg(err);
      pushError(rec, `${who}Sign-off swap failed for "${target.name}": ${msg(err)}`);
    }
    rec.updatedAt = Date.now();
    await persist(id);
  }

  const setupFailed = src.created.some((c) => c.state === "error" || c.optOut?.state === "error" || c.signature?.state === "error");
  src.phaseStates.duplicating = setupFailed ? "error" : "done";
  await persist(id);

  // Moving leads into a campaign that is missing, lacks its opt-out line or
  // still signs off with the wrong variable would send the wrong email — and
  // the move is the irreversible half.
  if (setupFailed) {
    pushError(
      rec,
      `${who}Stopped before moving any leads: a campaign is missing, lacks its opt-out copy or still has the wrong sign-off. Fix it in Plusvibe, then run again — the copies already made are reused, both copy steps are idempotent, and no leads have moved.`
    );
    src.state = "error";
    return;
  }

  // --- moving leads ------------------------------------------------------------
  src.phase = "moving";
  src.phaseStates.moving = "running";

  // A campaign that was not asked for, or was not found, is not a destination:
  // its share stays with the campaigns in the same pool that are there.
  const availability: Availability = { blue: false, blueOptOut: false, blueSignature: false, optOut: false, signature: false };
  for (const role of CREATED_ROLES) availability[role] = !!src.created.find((c) => c.role === role)?.campaignId;
  const plan = planSplitFor(sides.blue, sides.plain, availability);
  src.moving.staysInSource = plan.counts.source;
  for (const t of src.moving.targets) t.planned = plan.counts[t.role];
  src.moving.plannedTotal = src.moving.targets.reduce((n, t) => n + t.planned, 0);
  await persist(id);

  // What did not move stays in the source, which is launched too, so a
  // refused lead is recorded and the split carries on — it is never a
  // reason to stop, and never a reason not to activate.
  let moveProblems = false;
  const reasons: Record<string, number> = {};
  for (const move of plan.moves) {
    check();
    const target = src.moving.targets.find((t) => t.role === move.destination);
    const destinationCampaignId = src.created.find((c) => c.role === move.destination)?.campaignId;
    if (!target || !destinationCampaignId) continue;
    if (move.leads.length === 0) {
      target.state = "done";
      continue;
    }
    target.state = "running";
    const res = await moveInto(ctx, {
      from: sourceCampaignId,
      to: destinationCampaignId,
      toName: target.name,
      leads: move.leads as RawLead[],
      onProgress: (n) => {
        src.moving.processed += n;
      },
    });
    target.moved += res.moved;
    if (res.unmoved.length > 0) {
      countReasons(res.unmoved, reasons);
      target.unmoved = (target.unmoved ?? 0) + res.unmoved.length;
      src.moving.unmoved = (src.moving.unmoved ?? 0) + res.unmoved.length;
      src.moving.unmovedReasons = { ...reasons };
      moveProblems = true;
    }
    if (res.inBoth > 0) moveProblems = true;
    if (ctx.quotaHit) src.moving.quotaHit = true;
    target.state = (target.unmoved ?? 0) > 0 ? "error" : "done";
    await persist(id);
  }

  if ((src.moving.unmoved ?? 0) > 0) {
    pushError(
      rec,
      `${who}${src.moving.unmoved} lead${src.moving.unmoved === 1 ? "" : "s"} stayed in the source campaign: ${describeReasons(reasons)}. They were not deleted from anywhere; the source is launched with them in it.`
    );
  }
  src.phaseStates.moving = moveProblems ? "error" : "done";
  await persist(id);

  // --- activating ----------------------------------------------------------------
  if (!activate) {
    src.phaseStates.activating = "skipped";
    for (const a of src.activation) a.state = "skipped";
    src.state = moveProblems ? "error" : "done";
    src.phase = "finished";
    await persist(id);
    return;
  }

  src.phase = "activating";
  src.phaseStates.activating = "running";
  await persist(id);

  for (const target of src.activation) {
    check();
    const campaignId = target.role === "source" ? sourceCampaignId : src.created.find((c) => c.role === target.role)?.campaignId;
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
      pushError(rec, `${who}Could not activate "${target.name}": ${msg(err)}`);
    }
    rec.updatedAt = Date.now();
    await persist(id);
  }

  const activationFailed = src.activation.some((a) => a.state === "error");
  src.phaseStates.activating = activationFailed ? "error" : "done";
  // Everything real is done by this point — the campaigns exist, carry the
  // right copy and hold the right leads. A failed launch is a one-click fix
  // in Plusvibe, so it is reported without discarding the run.
  src.state = activationFailed || moveProblems ? "error" : "done";
  src.phase = "finished";
  await persist(id);
}

// --- Phase 3: the pool tags -------------------------------------------------------

async function runTagging(ctx: RunCtx) {
  const { rec, apiKey, workspaceId, check, id } = ctx;
  rec.phase = "tagging";
  rec.phaseStates.tagging = "running";

  // Every campaign that exists, by pool: the originals and plain copies are
  // Google campaigns, the 🔵 copies Microsoft ones.
  const targets: TagTarget[] = [];
  for (const src of rec.sources) {
    targets.push({ campaignId: src.campaignId, name: src.campaignName, tag: "google-pool", state: "pending" });
    for (const c of src.created) {
      if (!c.campaignId) continue;
      targets.push({ campaignId: c.campaignId, name: c.name, tag: poolOf(c.role) === "google" ? "google-pool" : "microsoft-pool", state: "pending" });
    }
  }
  rec.tagging.targets = targets;
  await persist(id);

  let ids: Record<"google" | "microsoft", string>;
  try {
    check();
    const r = await resolvePoolTags(apiKey, workspaceId);
    ids = r.ids;
    rec.tagging.tagsCreated = r.created;
  } catch (err) {
    if (err instanceof AbortedError || ctx.m.aborted) throw err;
    for (const t of targets) {
      t.state = "error";
      t.error = msg(err);
    }
    pushError(rec, `Could not find or create the pool tags in this workspace: ${msg(err)}. No campaign was tagged; the campaigns and their leads are unaffected.`);
    rec.phaseStates.tagging = "error";
    await persist(id);
    return;
  }

  // What every campaign carries now. A copy duplicated from an original that
  // was already tagged arrives with that tag, so the wrong pool's tag has to
  // come off — and only off the campaigns found carrying it.
  let carried = new Map<string, string[]>();
  try {
    check();
    carried = await readCampaignTags(apiKey, workspaceId);
  } catch (err) {
    if (err instanceof AbortedError || ctx.m.aborted) throw err;
    pushError(rec, `Could not read the campaigns' current tags: ${msg(err)}. The pool tags were added, but a copy that inherited the other pool's tag keeps it — check the 🔵 campaigns for google-pool.`);
  }

  let failed = false;
  for (const pool of ["google", "microsoft"] as const) {
    check();
    const other = pool === "google" ? "microsoft" : "google";
    const tagName = `${pool}-pool`;
    const wrongName = `${other}-pool`;
    const mine = targets.filter((t) => t.tag === tagName);
    if (mine.length === 0) continue;
    for (const t of mine) t.state = "running";
    await persist(id);

    const wrong = mine.filter((t) => (carried.get(t.campaignId) ?? []).includes(ids[other]));
    try {
      await unassignCampaignTag(apiKey, workspaceId, wrong.map((t) => t.campaignId), ids[other]);
      for (const t of wrong) t.removed = wrongName;
    } catch (err) {
      if (err instanceof AbortedError || ctx.m.aborted) throw err;
      failed = true;
      pushError(rec, `Could not take ${wrongName} off ${wrong.length} campaign${wrong.length === 1 ? "" : "s"} that inherited it: ${msg(err)}. Remove it in Plusvibe; nothing else is affected.`);
    }
    try {
      await assignCampaignTag(apiKey, workspaceId, mine.map((t) => t.campaignId), ids[pool]);
      for (const t of mine) t.state = "done";
    } catch (err) {
      if (err instanceof AbortedError || ctx.m.aborted) throw err;
      failed = true;
      for (const t of mine) {
        t.state = "error";
        t.error = msg(err);
      }
      pushError(rec, `Could not tag ${mine.length} campaign${mine.length === 1 ? "" : "s"} ${tagName}: ${msg(err)}. Add the tag in Plusvibe; nothing else is affected.`);
    }
    rec.updatedAt = Date.now();
    await persist(id);
  }
  rec.phaseStates.tagging = failed ? "error" : "done";
  await persist(id);
}

async function runJob(id: string) {
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m || !m.apiKey || !m.payload) return;

  const mode = rec.mode ?? "create";
  const activate = mode !== "move" && m.payload.activate !== false;
  const ctx: RunCtx = {
    id,
    rec,
    m,
    apiKey: m.apiKey,
    workspaceId: m.payload.workspaceId,
    check: () => {
      if (m.aborted) throw new AbortedError();
    },
    quotaHit: false,
    sinceFlush: 0,
  };

  try {
    // A fix run is its own thing: read, take the segment, move, and make sure
    // every campaign it touched is running. Nothing is built, so the three
    // phases below do not apply.
    if (mode === "fix") {
      await runFixAllocation(ctx, m.payload);
      // A campaign left inactive is the one thing this run was asked to rule
      // out, so it marks the run, even though every lead is in place.
      const inactive = rec.allocation?.activation?.some((a) => a.state === "error") ?? false;
      rec.status = rec.allocation?.state === "error" || inactive ? "error" : "done";
      return;
    }

    // --- Phase 1 --------------------------------------------------------------
    if (m.payload.rules.length > 0) await runSegmenting(ctx, m.payload.rules);
    else rec.phaseStates.segmenting = "skipped";

    // --- Phase 2 --------------------------------------------------------------
    rec.phase = "building";
    rec.phaseStates.building = "running";
    await persist(id);

    // The workspace's live campaigns. A create run uses them to adopt copies
    // it already made instead of making a second set under the same names —
    // duplication is not idempotent on its own. A move run uses them to find
    // the campaigns to move into.
    //
    // Archived campaigns are excluded either way: adopting or matching one is
    // silently fatal, since it reads as a success and then cannot take a
    // single lead.
    let workspaceCampaigns: CampaignSummary[] = [];
    try {
      workspaceCampaigns = await listCampaigns(ctx.apiKey, ctx.workspaceId);
    } catch (err) {
      // Without the list we can't tell a resumed run from a fresh one, and
      // duplicating blind could leave a second set of campaigns behind.
      pushError(
        rec,
        mode === "move"
          ? `Could not list the workspace's campaigns to find the ones to move into: ${msg(err)}. Nothing was moved.`
          : `Could not list the workspace's campaigns to check for copies already made: ${msg(err)}. Stopped before duplicating anything.`
      );
      rec.phaseStates.building = "error";
      rec.phaseStates.tagging = "skipped";
      rec.status = "error";
      return;
    }
    const existingByName = mode === "create" ? buildReuseIndex(workspaceCampaigns) : new Map<string, string>();
    const roles = rolesFor(rec.kinds as CampaignKind[]);

    for (const src of rec.sources) {
      ctx.check();
      await runSource(ctx, src, { mode, activate, existingByName, workspaceCampaigns, roles });
      rec.updatedAt = Date.now();
      await persist(id);
    }
    const buildingFailed = rec.sources.some((s) => s.state === "error");
    rec.phaseStates.building = buildingFailed ? "error" : "done";
    await persist(id);

    // --- Phase 3 --------------------------------------------------------------
    await runTagging(ctx);

    const failed =
      rec.phaseStates.segmenting === "error" || buildingFailed || rec.phaseStates.tagging === "error";
    rec.status = failed ? "error" : "done";
  } catch (err) {
    if (err instanceof AbortedError || m.aborted) {
      rec.status = "aborted";
    } else {
      pushError(rec, msg(err));
      rec.status = "error";
      const phase = rec.phase;
      if (phase !== "finished") rec.phaseStates[phase] = "error";
      const src = rec.sources.find((s) => s.state === "running");
      if (src) {
        src.state = "error";
        if (src.phase !== "finished") src.phaseStates[src.phase] = "error";
      }
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

export async function getJob(apiKey: string, id: string): Promise<CampaignTypesJob | null> {
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
