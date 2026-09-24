// When a blocked inbox ends its domain too.
//
//   Google     A Google domain has no tenant: each inbox is its own seat. The
//              domain is finished when its last inbox is — so once the inbox
//              just blocked is the only one left that isn't already blocked,
//              the domain goes Not Active in 📋 Domains.
//
//   Microsoft  A Microsoft domain sits on a tenant that is paid for as a
//              whole. Losing inboxes one by one is expected; losing more than
//              N of them (N on Settings, 13 by default) says the domain is
//              gone. It is then cancelled the way the old automation cancelled
//              a domain: the inboxes still getting replies are kept, every
//              other one is stopped and deleted, and the domain goes Not
//              Active with its tenant onto 🚯 Tenants to Cancel. Once.
//
// Pure module — no API — so all of it is unit-tested.

import { ratesOf, type InboxFigures } from "@/lib/blocked-inboxes/rules";

const lower = (s: string) => s.trim().toLowerCase();

/**
 * Whether `email` is the last inbox standing on its domain: every other inbox
 * on the domain has already been blocked (stopped or deleted) by this
 * automation, or there are none.
 */
export function isLastOnDomain(domainInboxes: string[], email: string, alreadyBlocked: Iterable<string>): boolean {
  const blocked = new Set([...alreadyBlocked].map(lower));
  const me = lower(email);
  return domainInboxes.map(lower).every((e) => e === me || blocked.has(e));
}

/**
 * Whether a Microsoft domain is due its cancellation: MORE than `after`
 * inboxes deleted by the rules, and not cancelled (or being cancelled) yet.
 */
export function shouldCancel(state: { deletedByRules: number; cancelledAt?: number; cancelling?: boolean }, after: number): boolean {
  return state.deletedByRules > after && state.cancelledAt === undefined && !state.cancelling;
}

export interface CancelCandidate<T> {
  inbox: T;
  email: string;
  /** Null when Plusvibe returned no figures for it. */
  figures: InboxFigures | null;
}

export interface CancelPlan<T> {
  /** Still getting replies: left alone. */
  keep: { inbox: T; email: string; oooReplyRate: number }[];
  /** Everything else: stopped and deleted. */
  cancel: { inbox: T; email: string; oooReplyRate: number | null; figures: InboxFigures | null }[];
}

/**
 * Which of a cancelled domain's inboxes stay. An inbox is kept when its OOO
 * reply rate is at least `keepRate` — the old automation's inbox bar. One
 * with no figures has shown nothing to keep it for, so it goes with the rest.
 */
export function planCancellation<T>(candidates: CancelCandidate<T>[], keepRate: number): CancelPlan<T> {
  const plan: CancelPlan<T> = { keep: [], cancel: [] };
  for (const c of candidates) {
    if (!c.figures || c.figures.sent === 0) {
      plan.cancel.push({ inbox: c.inbox, email: c.email, oooReplyRate: c.figures ? 0 : null, figures: c.figures });
      continue;
    }
    const rate = ratesOf(c.figures).oooReplyRate;
    if (rate >= keepRate) plan.keep.push({ inbox: c.inbox, email: c.email, oooReplyRate: rate });
    else plan.cancel.push({ inbox: c.inbox, email: c.email, oooReplyRate: rate, figures: c.figures });
  }
  return plan;
}
