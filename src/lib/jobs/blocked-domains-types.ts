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
// The assessment applies TWO bars, because they answer different questions:
//
//   inbox bar (1%)    a mailbox under it has its daily limit set to 0 and its
//                     warmup switched off — whatever the domain is doing
//   domain bar (1.5%) a domain under it is written off: Not Active in the
//                     sheet and its tenant queued for cancellation. At or
//                     above it, the sheet and tenant are LEFT ALONE and
//                     nothing is deleted; the run is recorded as "kept".
//
// So a domain still replying keeps its status and its tenant while its weak
// mailboxes are stopped, and a domain that isn't replying is written off while
// its individual mailboxes that ARE still replying keep sending and stay out
// of the deletion.
//
// For a domain under its bar, steps 3-4 run unattended: its weak inboxes are
// already stopped, so "Not Active" is just true, and the tenant needs
// cancelling either way. Only the deletion is irreversible, so only the
// deletion waits for a person — and declining it does not un-write the sheet.
//
// Quarantine happens without confirmation on purpose: a mailbox that isn't
// replying from a blocked domain is burning reputation, and stopping it is
// reversible.

import type {
  DomainPerformance,
  DomainVerdict,
  InboxAssessment,
} from "@/lib/blocked-domains/performance";
import type { ProviderCounts } from "@/lib/plusvibe-providers";

export type { DomainPerformance, DomainVerdict, InboxAssessment, ProviderCounts };

export const MAX_STORED_ERRORS = 30;

export type BlockedDomainStatus =
  /** Locating and quarantining. */
  | "working"
  /**
   * The domain cleared its bar, so it was not written off: no sheet edit, no
   * tenant queued to cancel, nothing deleted. Its inboxes under the inbox bar
   * were still stopped.
   */
  | "kept"
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
  /** The registrar the domain sits with, from the sheet's Domain Host column. */
  domainHost?: string;
  /**
   * True when the domain was handled on the Google path: no tenant to cancel,
   * burned inboxes listed one by one instead, and Not Active only once every
   * inbox is burned.
   */
  googlePath?: boolean;
  /** Google path: inboxes appended to 🛑 Google Inboxes to Cancel by this run. */
  googleQueued?: string[];
  /** Google path: burned inboxes that were already on the tab. */
  googleAlreadyQueued?: string[];
  /** Set when the sheet could not be read or written at all. */
  error?: string;
  /** Undo write-off: the Status the row was put back to, and when. */
  revertedTo?: string;
  revertedAt?: number;
  /** Something the automation could not undo itself and a person must. */
  manualCleanup?: string;
}

/** One inbox as re-judged on the wider window. */
export interface RejudgedInbox extends InboxAssessment {
  /** This automation stopped it. */
  stoppedByUs: boolean;
  /** Daily limit above 0 when re-judged. */
  sendingNow: boolean;
}

/**
 * What the current rules say about a domain handled under earlier ones, read
 * over a window that reaches back to before it was flagged. Decides nothing:
 * Restore and Undo write-off are separate, explicit actions.
 */
export interface RejudgeOutcome {
  at: number;
  /** The window read, as YYYY-MM-DD. */
  start: string;
  end: string;
  threshold: number;
  domainThreshold: number;
  source: "bulk" | "per-inbox" | "unavailable";
  domain: DomainPerformance;
  inboxes: RejudgedInbox[];
  /** Stopped by us, but clear the bar on the wider window. */
  restorable: string[];
  /** Under the bar on the wider window. */
  stillUnder: string[];
  /** Whether the current rules would write the domain off. */
  wouldWriteOff: boolean;
  googlePath: boolean;
  /** A daily limit to offer for restoring, from the workspace's sending inboxes. */
  suggestedLimit?: number;
}

/** Inboxes turned back on by a person, after re-judging. */
export interface RestoreRun {
  at: number;
  emails: string[];
  dailyLimit: number;
  /** Set when either half (limit or warmup) did not land for some inbox. */
  error?: string;
}

export interface PerformanceOutcome {
  /** The window read, as YYYY-MM-DD. */
  start: string;
  end: string;
  /** The per-inbox reply-rate-with-OOO bar, in percent. */
  threshold: number;
  /** The bar the DOMAIN had to clear to keep its sheet status and tenant. */
  domainThreshold?: number;
  /** The whole domain's figures over the window, and its verdict. */
  domain?: DomainPerformance;
  /** Which endpoint answered, or that no figures were available. */
  source: "bulk" | "per-inbox" | "unavailable" | "skipped";
  /** Per inbox, in the order they were found. */
  inboxes: InboxAssessment[];
  /** Set when the check could not run, so everything was stopped. */
  note?: string;
}

/** One repeat check of a domain that was flagged earlier. */
export interface RecheckRun {
  at: number;
  trigger: "scheduled" | "manual";
  inboxesFound: number;
  /** Of those, how many were still sending after the run. */
  inboxesActive?: number;
  /** The domain's rate at that moment, and what it meant. */
  domainReplyRateOoo?: number;
  verdict?: DomainVerdict;
  /** Inboxes stopped by THIS run — ones that had held up until now. */
  stopped: number;
  /** Inboxes still above the inbox bar afterwards. */
  kept: number;
  /** True when this run was the one that wrote the domain off. */
  wroteOff?: boolean;
  error?: string;
}

export interface RecheckState {
  enabled: boolean;
  /** How often, in days. */
  everyDays: number;
  nextAt?: number;
  runs: RecheckRun[];
  /** Why the repeat checks ended, when they have. */
  endedReason?: string;
}

export const MAX_RECHECK_RUNS = 20;

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
  /**
   * How many of the domain's inboxes were still sending when it was last
   * looked at — daily limit above 0. Counts inboxes stopped by hand in
   * Plusvibe too, not just the ones this automation stopped.
   */
  inboxesActive?: number;
  /**
   * Google / Microsoft / other, counted over the inboxes found on the domain.
   *
   * Recorded because the kind of tenant a blocked domain was running on is
   * part of the same question as its registrar and its ending: which setups
   * keep producing blocks.
   */
  providers?: ProviderCounts;
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

  /**
   * The repeat checks. A flagged domain rarely stops declining, so the same
   * assessment is repeated on a schedule until there is nothing left to watch.
   */
  recheck?: RecheckState;

  /** The last re-judgement, when someone asked for one. */
  rejudge?: RejudgeOutcome;
  /** Inboxes turned back on after re-judging, newest first. */
  restores?: RestoreRun[];

  errors: string[];
  errorsTruncated?: boolean;
}

export interface BlockedDomainsView {
  jobs: BlockedDomainJob[];
  /** A "Re-judge all" in progress, or the last one. */
  rejudgeAll?: { running: boolean; total: number; done: number; startedAt: number };
  settings: {
    autoDelete: boolean;
    checkPerformance: boolean;
    minReplyRateOoo: number;
    minDomainReplyRateOoo: number;
    recheck: boolean;
    recheckDays: number;
  };
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
    /**
     * Where the records live and whether that survives a redeploy. Absent on
     * responses from a build before this was reported.
     */
    jobStorage?: {
      dir: string;
      configured: boolean;
      onVolume: boolean | null;
      mountPoint?: string;
    };
  };
}
