// The decisions in a Pause Campaigns run, with no API calls, so they can be
// unit-tested: which campaigns get paused, in what order they are paused and
// resumed, and whether a resume date is acceptable.

import type { CampaignKind } from "@/lib/jobs/pause-campaigns-types";

/** The parts of a campaign this module needs. */
export interface CampaignLike {
  id: string;
  name: string;
  status: string;
  campaignType?: string;
  parentCampId?: string;
}

export interface PlannedCampaign {
  id: string;
  name: string;
  kind: CampaignKind;
  parentId?: string;
}

export interface PausePlanResult {
  /** Parents first, then sub-sequences — see orderForPause. */
  toPause: PlannedCampaign[];
  /** Not ACTIVE, so left exactly as they are. */
  skipped: number;
  parents: number;
  subsequences: number;
}

export function kindOf(c: { campaignType?: string }): CampaignKind {
  return c.campaignType === "subseq" ? "subseq" : "parent";
}

/**
 * Only ACTIVE campaigns are paused.
 *
 * Anything else — paused by hand, a draft, completed, archived — is left
 * exactly as it is. That matters twice over: pausing a draft is meaningless,
 * and the resume later turns on precisely what this pass turned off. A
 * campaign someone paused deliberately last week must not come back on
 * because it happened to be in the workspace.
 */
export function planPause(campaigns: CampaignLike[]): PausePlanResult {
  const active = campaigns.filter(
    (c) => c.id && c.status.trim().toUpperCase() === "ACTIVE"
  );
  const toPause = orderForPause(
    active.map((c) => ({
      id: c.id,
      name: c.name,
      kind: kindOf(c),
      parentId: c.parentCampId || undefined,
    }))
  );
  return {
    toPause,
    skipped: campaigns.length - active.length,
    parents: toPause.filter((c) => c.kind === "parent").length,
    subsequences: toPause.filter((c) => c.kind === "subseq").length,
  };
}

/**
 * Parents before their sub-sequences.
 *
 * Plusvibe requires a parent to be active before its sub-sequences can be, so
 * the resume has to go parents-first. Pausing in the same order keeps the two
 * passes mirror images and the record easy to read. Within a kind the given
 * order is kept.
 */
export function orderForPause<T extends { kind: CampaignKind }>(list: T[]): T[] {
  return [
    ...list.filter((c) => c.kind === "parent"),
    ...list.filter((c) => c.kind === "subseq"),
  ];
}

/** The resume order — the same rule, named for what it's for. */
export const orderForResume = orderForPause;

export const MIN_RESUME_LEAD_MS = 60_000;
export const MAX_RESUME_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Whether a resume time can be scheduled. Returns the problem, or null.
 *
 * A time in the past would fire on the very next tick, i.e. pause and resume
 * within the minute — never what anyone meant. A year out is a typo guard.
 */
export function validateResumeAt(
  resumeAt: unknown,
  now = Date.now()
): string | null {
  if (typeof resumeAt !== "number" || !Number.isFinite(resumeAt)) {
    return "The resume time is not a valid date.";
  }
  if (resumeAt < now + MIN_RESUME_LEAD_MS) {
    return "The resume time has to be at least a minute from now.";
  }
  if (resumeAt > now + MAX_RESUME_AHEAD_MS) {
    return "The resume time is more than a year away — check the date.";
  }
  return null;
}

/**
 * Whether a job's scheduled resume should fire now.
 *
 * Statuses other than "paused" are included on purpose: a pause that was
 * stopped or interrupted part-way still left real campaigns paused, and the
 * date the user set still applies to them. Anything already resumed, being
 * resumed, or finished is excluded.
 */
export function isResumeDue(
  job: { status: string; resumeAt?: number; resumedAt?: number },
  now = Date.now()
): boolean {
  if (job.resumeAt === undefined || job.resumedAt !== undefined) return false;
  if (!["paused", "aborted", "interrupted"].includes(job.status)) return false;
  return job.resumeAt <= now;
}

/** "Alpha", "Alpha, Bravo", "Alpha, Bravo +3 more". */
export function labelFor(names: string[]): string {
  const clean = names.map((n) => n.trim()).filter(Boolean);
  if (clean.length === 0) return "No workspaces";
  if (clean.length <= 2) return clean.join(", ");
  return `${clean.slice(0, 2).join(", ")} +${clean.length - 2} more`;
}
