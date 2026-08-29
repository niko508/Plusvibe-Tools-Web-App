// Shared types for the Blocked Domains automation (server + client).
//
// Clay detects a blocked sending domain from a bounce reason and calls our
// webhook. From there:
//
//   1 locating     find the domain's workspace and its inboxes
//   2 quarantining stop the bleeding — campaign daily limit to 0, warmup off
//   3 (waiting)    someone confirms in the UI, unless auto-delete is on
//   4 deleting     delete the inboxes
//   5 sheet        📋 Domains status → Not Active, tenant → 🚯 Tenants to Cancel
//
// Quarantine happens without confirmation on purpose: a blocked domain is
// actively burning reputation, and stopping it is reversible. Deletion isn't.

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
  | "quarantining"
  | "deleting"
  | "sheet"
  | "finished";

export const PHASE_ORDER: Exclude<BlockedDomainPhase, "finished">[] = [
  "locating",
  "quarantining",
  "deleting",
  "sheet",
];

export const PHASE_LABELS: Record<BlockedDomainPhase, string> = {
  locating: "Finding the inboxes",
  quarantining: "Stopping sending & warmup",
  deleting: "Deleting inboxes",
  sheet: "Updating the sheet",
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

  sheet?: SheetOutcome;

  errors: string[];
  errorsTruncated?: boolean;
}

export interface BlockedDomainsView {
  jobs: BlockedDomainJob[];
  settings: { autoDelete: boolean };
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
