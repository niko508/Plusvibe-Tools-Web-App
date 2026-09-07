// Shared types for the Blocked Domains automation (server + client).
//
// Clay detects a blocked sending domain from a bounce reason and calls our
// webhook. From there:
//
//   1 locating     find the domain's workspace and its inboxes
//   2 assessing    read each inbox's last 7 days and decide which have to stop
//   3 quarantining stop the bleeding — campaign daily limit to 0, warmup off
//   4 sheet        📋 Domains status → Not Active, then the tenant onto
//                  🚯 Tenants to Cancel
//   5 (waiting)    someone confirms in the UI, unless auto-delete is on
//   6 deleting     delete the stopped inboxes
//
// An inbox still replying is left alone by every step after the assessment: it
// is not stopped, and it is not deleted. Only the stopped ones are.
//
// Steps 1-3 all run unattended. The domain is blocked and its inboxes are
// already stopped, so "Not Active" is just true, and the tenant needs
// cancelling either way. Only the deletion is irreversible, so only the
// deletion waits for a person — and declining it does not un-write the sheet.
//
// Quarantine happens without confirmation on purpose: a blocked domain is
// actively burning reputation, and stopping it is reversible. Deletion isn't.

import type { InboxAssessment } from "@/lib/blocked-domains/performance";

export type { InboxAssessment };

export const MAX_STORED_ERRORS = 30;

export type BlockedDomainStatus =
  /** Locating and quarantining. */
  | "working"
  /** Quarantined, waiting for someone to confirm the deletion. */
  | "awaiting_confirmation"
  /** Confirmed (or auto-confirmed) and deleting. */
  | "deleting"
  | "done"
  /** Someone decided not to delete; the quarantine stays in place. */
  | "dismissed"
  | "error"
  | "interrupted";

export type BlockedDomainPhase =
  | "locating"
  | "assessing"
  | "quarantining"
  | "deleting"
  | "sheet"
  | "finished";

export const PHASE_ORDER: Exclude<BlockedDomainPhase, "finished">[] = [
  "locating",
  "assessing",
  "quarantining",
  "sheet",
  "deleting",
];

export const PHASE_LABELS: Record<BlockedDomainPhase, string> = {
  locating: "Finding the inboxes",
  assessing: "Checking the last 7 days",
  quarantining: "Stopping sending & warmup",
  sheet: "Updating the sheet",
  deleting: "Deleting inboxes",
  finished: "Finished",
};

export type PhaseState =
  | "pending"
  | "running"
  | "done"
  | "skipped"
  | "error"
  /** Quarantined and waiting for a person. */
  | "waiting";

export interface SheetOutcome {
  /** 📋 Domains row set to "Not Active". */
  statusUpdated: boolean;
  /** The 1-based row it changed, for checking against the sheet. */
  domainRow?: number;
  previousStatus?: string;
  /** Tenant appended to 🚯 Tenants to Cancel. */
  tenantQueued: boolean;
  /** True when the tenant was already on the cancel list. */
  tenantAlreadyQueued?: boolean;
  tenantEmail?: string;
  tenantSource?: string;
  /** Client from the sheet, which is also the workspace hint. */
  client?: string;
  /** Set when the sheet could not be read or written at all. */
  error?: string;
}

export interface PerformanceOutcome {
  /** The window read, as YYYY-MM-DD. */
  start: string;
  end: string;
  /** The reply-rate-with-OOO bar, in percent. */
  threshold: number;
  /** Which endpoint answered, or that no figures were available. */
  source: "bulk" | "per-inbox" | "unavailable" | "skipped";
  /** Per inbox, in the order they were found. */
  inboxes: InboxAssessment[];
  /** Set when the check could not run, so everything was stopped. */
  note?: string;
}

export interface BlockedDomainJob {
  id: string;
  /** The normalized domain. Also the duplicate key. */
  domain: string;
  status: BlockedDomainStatus;
  phase: BlockedDomainPhase;
  phaseStates: Record<Exclude<BlockedDomainPhase, "finished">, PhaseState>;
  createdAt: number;
  updatedAt: number;

  /** What Clay said, kept for context in the log. */
  bounceReason?: string;
  /** Where the trigger came from — "clay", or "manual" from the UI. */
  source: string;
  /** Later webhook hits for a domain already being handled. */
  duplicateHits: number;
  lastDuplicateAt?: number;

  workspaceId?: string;
  workspaceName?: string;
  /** True when the sheet's Client column pointed straight at the workspace. */
  foundViaSheet?: boolean;
  /** Workspaces scanned when the sheet gave no usable hint. */
  workspacesScanned?: number;

  /** Inboxes found on the domain. */
  inboxesFound: number;
  /** Inboxes whose sending and warmup were stopped. */
  inboxesQuarantined: number;
  /** Inboxes left sending because they are still replying. */
  inboxesKept?: number;
  /** What the last 7 days said, per inbox. */
  performance?: PerformanceOutcome;
  /**
   * The addresses that were stopped. Deletion works from this list, so a
   * restart between quarantine and confirmation can't widen it to inboxes
   * that were deliberately left sending.
   */
  quarantinedEmails?: string[];
  /** Campaign daily limit set to 0. */
  sendingStopped?: boolean;
  /** Warmup switched off. */
  warmupStopped?: boolean;
  /** Inboxes actually deleted. */
  inboxesDeleted: number;

  /** True when the run deleted without waiting, because the toggle was on. */
  autoDeleted?: boolean;
  /** Who/what released the deletion, once it happened. */
  confirmedAt?: number;
  /**
   * Set when someone deliberately allowed this domain to run again.
   *
   * The record stays in the log as history — it just stops being the thing
   * that blocks a new run. Before this existed, re-arming a domain meant
   * deleting its record, which threw away the very history worth keeping.
   */
  rearmedAt?: number;

  sheet?: SheetOutcome;

  errors: string[];
  errorsTruncated?: boolean;
}

export interface BlockedDomainsView {
  jobs: BlockedDomainJob[];
  settings: { autoDelete: boolean; checkPerformance: boolean; minReplyRateOoo: number };
  /** Whether the webhook can actually run unattended. */
  readiness: {
    /** PLUSVIBE_API_KEY is set, so the webhook has a key to work with. */
    serverKey: boolean;
    /** SPREADSHEET_ID is set and parses. */
    spreadsheet: boolean;
    /** A Google service account is configured for sheet writes. */
    sheetWriting: boolean;
    /** The shared secret Clay must send. */
    webhookSecret: boolean;
  };
}
