// When a flagged domain gets looked at again, and when to stop looking.
//
// A domain that produced a block rarely stabilises: the mailboxes that were
// still replying this week are the ones most likely to fall under the bar
// next week. So every flagged domain is re-assessed on a schedule — same two
// bars, same figures — until there is nothing left that a check could change.
//
// Pure module — no API calls, no clock of its own — so all of it is
// unit-tested.

import type { BlockedDomainJob, RecheckState } from "@/lib/jobs/blocked-domains-types";

export const DAY_MS = 86_400_000;
export const DEFAULT_RECHECK_DAYS = 7;
export const MAX_RECHECK_DAYS = 90;

/** Days between repeat checks: a whole number of days, 1 to 90. */
export function normalizeRecheckDays(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  if (!Number.isFinite(n) || n < 1) return DEFAULT_RECHECK_DAYS;
  return Math.min(MAX_RECHECK_DAYS, Math.round(n));
}

export function nextRunAt(from: number, everyDays: number): number {
  return from + everyDays * DAY_MS;
}

/** A record's checks are due when they're on, scheduled, and the time has passed. */
export function isRecheckDue(rec: BlockedDomainJob, now: number): boolean {
  const r = rec.recheck;
  if (!r || !r.enabled || r.nextAt === undefined) return false;
  if (rec.rearmedAt) return false; // superseded by a fresh run
  return r.nextAt <= now;
}

/**
 * Whether a run is allowed to start right now.
 *
 * A record mid-flight is left alone: the first pass is still deciding what to
 * do, and a second assessment on top of it would race the first.
 */
export function canRecheck(rec: BlockedDomainJob): boolean {
  return rec.status !== "working" && rec.status !== "deleting";
}

export interface EndCheck {
  /** Reason the repeat checks should stop, or null to keep going. */
  reason: string | null;
}

/**
 * Whether there is any point checking again.
 *
 * Two ways to be finished: the domain has no inboxes left at all, or it has
 * been written off AND every remaining inbox is already stopped — at which
 * point nothing a future check discovers would change anything.
 */
export function endOfTheLine(args: {
  inboxesFound: number;
  keptInboxes: number;
  writtenOff: boolean;
}): EndCheck {
  if (args.inboxesFound === 0) {
    return { reason: "No inboxes left on this domain." };
  }
  if (args.writtenOff && args.keptInboxes === 0) {
    return { reason: "The domain is written off and every inbox is stopped." };
  }
  return { reason: null };
}

/** The state a newly scheduled record starts with. */
export function startRecheck(now: number, everyDays: number, enabled: boolean): RecheckState {
  return {
    enabled,
    everyDays,
    nextAt: enabled ? nextRunAt(now, everyDays) : undefined,
    runs: [],
  };
}

/**
 * Moves an already-scheduled check onto a new interval.
 *
 * The gap is a setting for the whole automation, so changing it has to reach
 * the domains already being watched — otherwise each one keeps its old gap
 * until its next check happens to run, and the number on the page means
 * nothing for anything already flagged.
 *
 * The rule is the plain one: the next check is the new gap from now. A first
 * version kept the time already served instead, so a 7-day domain with two
 * days left became due in sixteen on a 21-day gap. That is arithmetically
 * tidy and not what anyone setting "21 days" expects to see: they expect
 * every watched domain to read "in 21 days".
 */
export function rebaseNextAt(
  state: Pick<RecheckState, "enabled">,
  newEveryDays: number,
  now: number
): number | undefined {
  if (!state.enabled) return undefined;
  return nextRunAt(now, newEveryDays);
}

/** "in 7 days" / "in 4 hours" / "due now" — how the next check reads. */
export function describeNext(nextAt: number | undefined, now: number): string {
  if (nextAt === undefined) return "not scheduled";
  const ms = nextAt - now;
  if (ms <= 0) return "due now";
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(ms / DAY_MS)} days`;
}
