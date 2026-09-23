// Picking up a run that a restart cut off.
//
// A deploy replaces the server, and whatever was running dies with it. The
// run can simply be started again — every step is safe to repeat: copies are
// adopted by name, the copy edits are idempotent, and only leads still in the
// source are read. What a plain re-run gets WRONG is the split. The leads it
// already moved are gone from the source, so it would divide only what is
// left, and the copy it was filling when it stopped would get its first share
// plus a fresh share of the rest.
//
// So a resumed run carries what was already moved, per copy, and the split is
// worked out on the whole (see planSplitFor / planAllocation).
//
// Pure module — no API — so all of it is unit-tested.

import { deriveNames } from "@/lib/campaign-types/names";
import type {
  CampaignTypesJob,
  CampaignTypesStartPayload,
  CreatedRole,
  MoveTarget,
  RoleNames,
  SourceRun,
} from "@/lib/jobs/campaign-types-types";
import { CREATED_ROLES } from "@/lib/jobs/campaign-types-types";

/** The order a run moves leads in — the same order planSplitFor emits. */
const MOVE_ORDER: CreatedRole[] = ["blue", "blueSignature", "blueOptOut", "signature", "optOut"];

/** How long after a restart a run is still picked up on its own. */
export const AUTO_RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Leads of a chunk that failed outright, by copy name, read back from the
 * run's own errors. Only needed for records written before per-copy counts
 * were kept live; see movedSoFar.
 */
function failedChunks(errors: string[]): Map<string, number> {
  const out = new Map<string, number>();
  const re = /Moving leads (\d+)–(\d+) to "(.+?)" failed twice at the add step/;
  for (const e of errors) {
    const m = re.exec(e);
    if (!m) continue;
    const n = Number(m[2]) - Number(m[1]) + 1;
    if (n > 0) out.set(m[3], (out.get(m[3]) ?? 0) + n);
  }
  return out;
}

/**
 * What each copy of one original holds from this run.
 *
 * Runs now count each copy's leads as they land. Records written before that
 * only counted a copy once it was finished, so the one being filled when the
 * run stopped reads 0 however far it got. For those, the run's overall
 * progress is walked through the copies in the order they were filled: every
 * copy before the one it stopped in got its full share, and that one got the
 * rest — less any chunk the run itself reported as failing.
 */
export function movedSoFar(src: SourceRun, errors: string[] = []): Partial<Record<CreatedRole, number>> {
  const out: Partial<Record<CreatedRole, number>> = {};
  const byRole = new Map<CreatedRole, MoveTarget>();
  for (const t of src.moving.targets) byRole.set(t.role, t);
  const failed = failedChunks(errors);

  let left = Math.max(0, src.moving.processed ?? 0);
  for (const role of MOVE_ORDER) {
    const t = byRole.get(role);
    if (!t) continue;
    const handled = Math.min(Math.max(0, t.planned), left);
    left -= handled;
    const counted = (t.moved ?? 0) + (t.unmoved ?? 0);
    // Counted live, or finished: the recorded number is the truth.
    let moved = t.moved ?? 0;
    if (counted < handled) {
      // The copy it stopped in, on an old record: estimate from progress.
      moved = Math.max(moved, handled - (t.unmoved ?? 0) - (failed.get(t.name) ?? 0));
    }
    if (moved > 0) out[role] = moved;
  }
  return out;
}

function add<K extends string>(a: Partial<Record<K, number>>, b: Partial<Record<K, number>>): Partial<Record<K, number>> {
  const out: Partial<Record<K, number>> = { ...a };
  for (const [k, v] of Object.entries(b) as [K, number][]) {
    const sum = (out[k] ?? 0) + (v ?? 0);
    if (sum > 0) out[k] = sum;
  }
  return out;
}

/**
 * The request that continues `job`: the one it was started with (or, for a
 * record from before requests were kept, the same request rebuilt from what
 * the record shows), carrying everything moved so far.
 *
 * Null when the record does not say enough to run again.
 */
export function resumePayload(job: CampaignTypesJob): CampaignTypesStartPayload | null {
  const mode = job.mode ?? "create";
  const workspaceId = job.request?.workspaceId ?? job.workspaceId;
  if (!workspaceId) return null;
  const base = job.request;

  if (mode === "fix") {
    const alloc = job.allocation;
    if (!alloc) return null;
    const segment = base?.segment ?? alloc.segment;
    const destinations = base?.destinations ?? alloc.destinations.map((d) => ({ campaignId: d.campaignId, campaignName: d.campaignName }));
    const sources = base?.sources ?? alloc.sources.map((s) => ({ campaignId: s.campaignId, campaignName: s.campaignName, names: namesFor(s.campaignName) }));
    if (!segment || destinations.length === 0 || sources.length === 0) return null;
    const carryAlloc: Record<string, number> = {};
    for (const d of alloc.destinations) {
      const n = (d.carried ?? 0) + (d.moved ?? 0);
      if (n > 0) carryAlloc[d.campaignId] = n;
    }
    return {
      mode: "fix",
      workspaceId,
      workspaceName: base?.workspaceName ?? job.workspaceName,
      sources,
      segment,
      destinations,
      kinds: [],
      rules: [],
      activate: false,
      ...(Object.keys(carryAlloc).length > 0 ? { carryAlloc } : {}),
    };
  }

  if (job.sources.length === 0) return null;
  const sources =
    base?.sources ??
    job.sources.map((s) => {
      const names = namesFor(s.campaignName);
      // The names the run actually used win over re-derived ones.
      for (const c of s.created) if (c.name) names[c.role] = c.name;
      return { campaignId: s.campaignId, campaignName: s.campaignName, names };
    });
  const carry: Record<string, Partial<Record<CreatedRole, number>>> = {};
  for (const s of job.sources) {
    const earlier: Partial<Record<CreatedRole, number>> = {};
    for (const t of s.moving.targets) if ((t.carried ?? 0) > 0) earlier[t.role] = t.carried;
    const total = add(earlier, movedSoFar(s, job.errors));
    if (Object.keys(total).length > 0) carry[s.campaignId] = total;
  }
  return {
    mode,
    workspaceId,
    workspaceName: base?.workspaceName ?? job.workspaceName,
    sources,
    kinds: base?.kinds ?? job.kinds,
    rules:
      base?.rules ??
      job.segmenting.rules.map((r) => ({ segment: r.segment, campaignId: r.campaignId, campaignName: r.campaignName })),
    activate: base?.activate ?? (mode === "create" && job.sources.some((s) => s.phaseStates.activating !== "skipped")),
    ...(Object.keys(carry).length > 0 ? { carry } : {}),
  };
}

function namesFor(sourceName: string): RoleNames {
  const derived = deriveNames(sourceName) as unknown as Partial<RoleNames>;
  const names = {} as RoleNames;
  for (const role of CREATED_ROLES) names[role] = derived[role] ?? "";
  return names;
}

/**
 * Whether a run should be picked up without anyone asking: interrupted by a
 * restart, not already continued, and recent enough that picking it up is
 * still what was wanted.
 */
export function shouldAutoResume(job: CampaignTypesJob, now: number, others: CampaignTypesJob[] = []): boolean {
  if (job.status !== "interrupted" || job.resumedAs) return false;
  const at = job.interruptedAt ?? job.updatedAt;
  if (now - at > AUTO_RESUME_WINDOW_MS) return false;
  return supersededBy(job, others) === null;
}

/** Every campaign a run reads leads out of. */
function campaignsRead(job: CampaignTypesJob): Set<string> {
  const ids = new Set<string>();
  for (const s of job.sources ?? []) ids.add(s.campaignId);
  for (const s of job.allocation?.sources ?? []) ids.add(s.campaignId);
  return ids;
}

/**
 * A later run that reads the same campaign, if there is one.
 *
 * Continuing the interrupted run then would be wrong, not just redundant: it
 * counts only its own moves, so it would finish a split the later run has
 * already redone and move the same share twice.
 */
export function supersededBy(job: CampaignTypesJob, others: CampaignTypesJob[]): CampaignTypesJob | null {
  const mine = campaignsRead(job);
  for (const o of others) {
    if (o.id === job.id || o.createdAt <= job.createdAt) continue;
    if (o.resumedFrom === job.id) continue;
    for (const id of campaignsRead(o)) if (mine.has(id)) return o;
  }
  return null;
}
