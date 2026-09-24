// Shared types for the inbox-level Blocked Domains automation (server + client).
//
// Clay sends the sender inbox it saw bouncing. From there:
//
//   1 find the inbox — its workspace, its provider
//   2 read its last 14 days and judge it on its tier (lib/blocked-inboxes/rules)
//   3 blocked → sending and warmup stopped straight away; a Google inbox is
//     listed on 🛑 Google Inboxes to Cancel
//   4 deleted — at once with Auto-delete on, or when someone confirms
//
// Nothing is done at the domain level any more: no domain-wide warmup pause,
// no Not Active in the Domains tab, nothing queued on 🚯 Tenants to Cancel.
// A domain appears in Blocked Domains because one of its inboxes was blocked.

import type { InboxFigures, InboxRates, InboxVerdict } from "@/lib/blocked-inboxes/rules";
import type { ProviderBucket } from "@/lib/plusvibe-providers";

export type { InboxFigures, InboxRates, InboxVerdict, ProviderBucket };

export const MAX_INBOX_ERRORS = 20;
export const MAX_INBOX_HISTORY = 10;

export type BlockedInboxStatus =
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

  /** The days judged, as the API dates them. */
  window?: { start: string; end: string };
  figures?: InboxFigures;
  rates?: InboxRates;
  verdict?: InboxVerdict;
  /** "46+ sends" */
  tier?: string;
  /** "bounce > 10% or OOO reply rate < 1.5%" */
  rule?: string;
  /** What failed, when blocked. */
  reasons?: string[];
  /** Set when a human reply rate kept a Google inbox that would be blocked. */
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

export interface BlockedInboxesView {
  jobs: BlockedInboxJob[];
}
