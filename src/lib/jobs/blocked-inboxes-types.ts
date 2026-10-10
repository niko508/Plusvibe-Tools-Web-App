// Shared types for the inbox-level Blocked Domains automation (server + client).
//
// Clay sends the sender inbox it saw bouncing. From there:
//
//   1 find the inbox — its workspace, its provider
//   2 read its last 7 and 14 days and judge it on the rule (lib/blocked-inboxes/rules)
//   3 blocked → sending and warmup stopped straight away; a Google inbox is
//     listed on 🛑 Google Inboxes to Cancel
//   4 deleted — at once with Auto-delete on, or when someone confirms
//
// Two things are done at domain level, each once a domain has earned it:
//
//   Google     the domain's last inbox is blocked → 📋 Domains status Not Active
//   Microsoft  more than N of its inboxes deleted by the rules (N on Settings,
//              13 by default) → the domain is cancelled the way the old
//              automation cancelled one: inboxes still getting replies are
//              kept, every other inbox is stopped and deleted, the domain goes
//              Not Active and its tenant onto 🚯 Tenants to Cancel.
//   Tenant Block  Clay's Tenant Block column says YES → the same, but for
//              every inbox on the domain: none are kept.
//
// What each domain has had done is kept in InboxDomainState, the deletion
// count among it.

import type { InboxFigures, InboxRates, InboxVerdict, RemovalRule } from "@/lib/blocked-inboxes/rules";
import type { ProviderBucket } from "@/lib/plusvibe-providers";

export type { InboxFigures, InboxRates, InboxVerdict, ProviderBucket };

export const MAX_INBOX_ERRORS = 20;
export const MAX_INBOX_HISTORY = 10;

export type BlockedInboxStatus =
  /** Waiting its turn: a few inboxes are checked at a time. */
  | "queued"
  /** Being found, read and judged. */
  | "working"
  /** Within its tier: nothing done. */
  | "passed"
  /** Neither Microsoft nor Google: recorded, never touched. */
  | "untouched"
  /** Not in any workspace. */
  | "not_found"
  /** Blocked and stopped; the deletion waits for someone. */
  | "awaiting_confirmation"
  | "deleting"
  /** Blocked and deleted. */
  | "deleted"
  /** Blocked, and someone chose to keep it: it stays stopped. */
  | "dismissed"
  | "error"
  | "interrupted";

/** One earlier judgement of the same inbox, kept when it is judged again. */
export interface InboxJudgementRecord {
  at: number;
  verdict: InboxVerdict;
  sent: number;
  bounceRate: number;
  oooReplyRate: number;
}

export interface BlockedInboxJob {
  id: string;
  /** The sender address, lower-case. Also the duplicate key. */
  email: string;
  domain: string;
  status: BlockedInboxStatus;
  createdAt: number;
  updatedAt: number;
  /** When it was last judged. */
  judgedAt?: number;
  /** "clay", or "manual" from the page. */
  source: string;
  bounceReason?: string;
  /** Later webhook hits for an inbox already handled. */
  duplicateHits: number;
  lastDuplicateAt?: number;

  workspaceId?: string;
  workspaceName?: string;
  accountId?: string;
  /** Google / Microsoft / other, as Plusvibe reports the mailbox. */
  provider?: ProviderBucket;
  /** What Plusvibe called it: GOOGLE_WORKSPACE, MICROSOFT365, … */
  providerRaw?: string;

  /**
   * The days judged, as the API dates them. On the OOO / human reply rule
   * (removalRule set) this is the OOO window; on the older tiers, the one
   * 14-day window everything was read over.
   */
  window?: { start: string; end: string };
  figures?: InboxFigures;
  rates?: InboxRates;
  verdict?: InboxVerdict;
  /** The OOO / human reply rule it was judged on, as it stood then; absent on the older tiers. */
  removalRule?: RemovalRule;
  /** The human reply window and its figures (removal rule). */
  humanWindow?: { start: string; end: string };
  humanFigures?: InboxFigures;
  humanRates?: InboxRates;
  /** Whether it had been sending long enough; null when that couldn't be read (removal rule). */
  sendingLongEnough?: boolean | null;
  /** Older tiers: "46+ sends". Also "tenant blocked" / "domain cancelled" on a cancellation. */
  tier?: string;
  /** The rule it was judged on, in words. */
  rule?: string;
  /** What failed, when blocked. */
  reasons?: string[];
  /** Why it was kept although part of the rule matched, or why it wasn't judged. */
  overruled?: string;
  /** Earlier judgements, newest first. */
  history?: InboxJudgementRecord[];

  /** When it was blocked. */
  blockedAt?: number;
  sendingStopped?: boolean;
  warmupStopped?: boolean;
  autoDeleted?: boolean;
  confirmedAt?: number;
  deletedAt?: number;
  dismissedAt?: number;

  /** Set when this inbox was blocked because its domain was cancelled. */
  cancelledWithDomain?: boolean;
  /** Google: this was the domain's last inbox, so the domain went Not Active. */
  lastOnDomain?: boolean;

  /**
   * Removed from Home. The record stays: a blocked inbox is still listed on
   * Blocked Inboxes, Blocked Domains, Tenant Blocks and in the stats. One that
   * wasn't blocked is judged afresh on its next bounce.
   */
  hiddenAt?: number;

  /** Google only: its row on 🛑 Google Inboxes to Cancel. */
  googleCancel?: { listed: boolean; alreadyThere?: boolean; error?: string };

  /** From the Domains sheet: the platform the domain was bought on. */
  domainHost?: string;
  /** From the public registry, when the sheet names no host. */
  registrar?: string;
  /** From the Domains sheet. */
  client?: string;
  tenantSource?: string;

  errors: string[];
}

/** Whether a run ended with the inbox blocked. */
export function isBlocked(job: Pick<BlockedInboxJob, "verdict" | "blockedAt">): boolean {
  return job.verdict === "block" || job.blockedAt !== undefined;
}

/** What has been done to one domain, across all its inbox runs. */
export interface InboxDomainState {
  domain: string;
  provider?: ProviderBucket;
  workspaceId?: string;
  workspaceName?: string;
  /** Microsoft inboxes on it the rules have deleted — what the cancellation counts. */
  deletedByRules: number;
  /** Set to Not Active in 📋 Domains, and why. */
  notActiveAt?: number;
  notActiveReason?: "last-google-inbox" | "microsoft-cancelled" | "tenant-block";
  /** Removed from Home; still on Blocked Domains and Tenant Blocks. */
  hiddenAt?: number;
  /** Google: the last inbox, whose blocking set the domain Not Active. Kept here so it outlives the inbox's own record. */
  lastInboxEmail?: string;
  previousStatus?: string;
  /**
   * Why the whole domain is being cancelled: its Microsoft inboxes passed the
   * deletion count, or Clay's Tenant Block column said so. Asked for at
   * `cancelRequestedAt`; a restart before `cancelledAt` picks it up again.
   */
  cancelReason?: "deleted-count" | "tenant-block";
  /**
   * Which Clay column asked for a whole-domain block: Domain Blocked or
   * Tenant Block. Both do the same; this is only what it is called. Absent on
   * older records, which were all Tenant Block.
   */
  blockColumn?: "domain-blocked" | "tenant-block";
  /** Clay's Stop Sending to Google: every inbox on the domain tagged No Sending to Google. */
  googleStop?: GoogleStopState;
  cancelRequestedAt?: number;
  /** Tenant Block: the inbox Clay sent it with, and later hits for the same domain. */
  tenantBlockEmail?: string;
  /** "clay", or "manual" from the Settings tab. */
  tenantBlockSource?: string;
  tenantBlockHits?: number;
  /** Cancelled — the old write-off, run once. */
  cancelledAt?: number;
  cancelling?: boolean;
  /** Inboxes kept at cancellation because they are still getting replies. */
  keptInboxes?: { email: string; oooReplyRate: number }[];
  /** Inboxes the cancellation stopped (and deletes). */
  cancelledInboxes?: string[];
  tenantEmail?: string;
  tenantQueued?: boolean;
  tenantAlreadyQueued?: boolean;
  errors: string[];
  updatedAt: number;
}

export const NO_GOOGLE_TAG = "No Sending to Google";

export interface GoogleStopState {
  requestedAt: number;
  /** The inbox Clay sent it with. */
  email?: string;
  source: string;
  running?: boolean;
  doneAt?: number;
  /** Tagged by this run, and already carrying the tag. */
  tagged: number;
  alreadyTagged: number;
  /** Where its inboxes were, with how many each. */
  workspaces: { workspaceId: string; workspaceName: string; inboxes: number }[];
  /** Clay sent it again after it was done. */
  hits: number;
  errors: string[];
}

export interface BlockedInboxesView {
  jobs: BlockedInboxJob[];
}
