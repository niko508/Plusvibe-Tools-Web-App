// Re-judging a domain that was handled under earlier rules.
//
// Records made before the ratio change stopped inboxes on a per-sent reply
// rate; records made before the provider was captured put Google domains
// through the tenant path. A stopped inbox has had no sends since, so the
// normal 7-day check can never rehabilitate it — it reads no sends and keeps
// it stopped. Re-judging reads a window that reaches back to BEFORE the
// domain was flagged, so the inbox's real sends are in view, and applies the
// current rules to that. It decides nothing on its own: it produces the list
// of what a person may restore, and what would still be stopped.
//
// Pure module — no clock, no API — so all of it is unit-tested.

import type { InboxAssessment, DomainPerformance } from "@/lib/blocked-domains/performance";

export const DAY_MS = 86_400_000;
/** Reach back this far before the domain was flagged. */
export const REJUDGE_LEAD_DAYS = 7;
/** But never further back than this from today: the API window has a limit. */
export const REJUDGE_MAX_DAYS = 30;

/**
 * The window to read: from a week before the domain was flagged through
 * today, capped at 30 days back. Returned as timestamps; the caller formats.
 */
export function rejudgeWindow(flaggedAt: number, now: number): { start: number; end: number } {
  const wanted = flaggedAt - REJUDGE_LEAD_DAYS * DAY_MS;
  const floor = now - REJUDGE_MAX_DAYS * DAY_MS;
  return { start: Math.max(wanted, floor), end: now };
}

export interface RejudgedInbox extends InboxAssessment {
  /** This automation stopped it (it is on the record's quarantined list). */
  stoppedByUs: boolean;
  /** Daily limit above 0 at the time of re-judging. */
  sendingNow: boolean;
}

export interface RejudgePlan {
  /** Stopped by us, but clear the bar on the wider window: a person may restore these. */
  restorable: string[];
  /** Under the bar on the wider window, whether stopped or not. */
  stillUnder: string[];
  /** Whether the current rules would write the domain off. */
  wouldWriteOff: boolean;
}

/**
 * What the current rules say about a domain, given fresh assessments.
 *
 * The write-off rule is the same one the live run uses: on the Google path it
 * is "every inbox burned", otherwise it is the domain's own verdict.
 */
export function planRejudge(args: {
  inboxes: RejudgedInbox[];
  domain: DomainPerformance;
  googlePath: boolean;
}): RejudgePlan {
  const restorable = args.inboxes
    .filter((i) => i.stoppedByUs && i.decision === "keep")
    .map((i) => i.email);
  const stillUnder = args.inboxes.filter((i) => i.decision === "stop").map((i) => i.email);
  const allBurned = args.inboxes.length > 0 && args.inboxes.every((i) => i.decision === "stop");
  const wouldWriteOff = args.googlePath ? allBurned : args.domain.verdict === "under";
  return { restorable, stillUnder, wouldWriteOff };
}

/**
 * A daily limit to offer when restoring: the one most of the still-sending
 * inboxes in the workspace use. Undefined when nothing is sending, in which
 * case the person types one.
 */
export function suggestLimit(inboxes: { dailyLimit?: number }[]): number | undefined {
  const counts = new Map<number, number>();
  for (const i of inboxes) {
    if (typeof i.dailyLimit === "number" && i.dailyLimit > 0) {
      counts.set(i.dailyLimit, (counts.get(i.dailyLimit) ?? 0) + 1);
    }
  }
  let best: number | undefined;
  let bestCount = 0;
  for (const [limit, n] of counts) {
    // Ties go to the higher limit: restoring is the point.
    if (n > bestCount || (n === bestCount && best !== undefined && limit > best)) {
      best = limit;
      bestCount = n;
    }
  }
  return best;
}

/** A daily limit someone typed: a whole number, 1 to 500. */
export function normalizeLimit(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  if (!Number.isFinite(n) || n < 1 || n > 500) return null;
  return Math.round(n);
}
