// Shared types for "Remove Inboxes & Domains" runs (server + client).
//
// A removal always follows a scan: it takes that scan's burned rows and its
// provider, so the bar a row was judged against is the bar it was removed on.
//
// Two phases, in this order and never overlapped:
//   sheet    everything the Email Infrastructure sheet needs to record, in as
//            few Sheets calls as the tabs allow
//   plusvibe the inboxes themselves, workspace by workspace
//
// The run lives in the Node process and is written to disk as it goes, so
// closing the tab doesn't stop it and reopening shows where it got to.

import type { Esp } from "@/lib/burned/settings";
import type { TargetResult } from "@/lib/burned/removal";

export const MAX_STORED_ERRORS = 50;

export type RemovalStatus = "running" | "done" | "aborted" | "interrupted" | "error";

export type PhaseState = "pending" | "running" | "done" | "skipped" | "error";

export interface SheetOutcome {
  /** Domains whose Status cell was set to "Not Active". */
  statusUpdated: number;
  /** Domains whose row already said "Not Active". */
  statusAlready: number;
  /** Tenants added to 🚯 Tenants to Cancel. */
  tenantsQueued: number;
  /** Tenants already on that tab. */
  tenantsAlready: number;
  /** Addresses added to 🛑 Google Inboxes to Cancel. */
  inboxesQueued: number;
  /** Addresses already on that tab. */
  inboxesAlready: number;
  error?: string;
}

export interface WorkspaceRemoval {
  workspaceId: string;
  workspaceName: string;
  state: "pending" | "listing" | "deleting" | "done" | "error";
  /** Targets in this workspace. */
  targets: number;
  inboxesDeleted: number;
  error?: string;
}

export interface BurnedRemovalJob {
  id: string;
  label: string;
  status: RemovalStatus;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;

  /** The scan this removal came from, so the card can sit under it. */
  scanJobId: string;
  esp: Esp;
  /** The spreadsheet being written, for the link on the card. */
  spreadsheetId: string;

  phase: "sheet" | "plusvibe" | "finished";
  phaseStates: { sheet: PhaseState; plusvibe: PhaseState };
  sheet: SheetOutcome;

  rows: TargetResult[];
  workspaces: WorkspaceRemoval[];

  progress: {
    /** Rows the sheet phase has recorded. */
    recorded: number;
    /** Rows whose inboxes have been dealt with. */
    removed: number;
    total: number;
    inboxesDeleted: number;
  };

  errors: string[];
  errorsTruncated?: boolean;
}

export interface RemovalStartPayload {
  /** The finished scan whose burned rows are removed. */
  scanJobId: string;
  /** The Email Infrastructure sheet; falls back to SPREADSHEET_ID. */
  sheetUrl?: string;
}
