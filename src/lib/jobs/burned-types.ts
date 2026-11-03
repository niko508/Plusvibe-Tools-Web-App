// Shared types for Find Burned Domains & Inboxes jobs (server + client).
//
// One provider, one date range, every workspace on the key. Per workspace:
// list the inboxes, keep the ones on that provider, read their stats in bulk,
// and judge them — inbox by inbox for Google, domain by domain for Microsoft.
// Nothing is written; the run only reports.

import type { Esp, Thresholds } from "@/lib/burned/settings";
import type { ScanCounts, ScanRow } from "@/lib/burned/scan";

export const MAX_STORED_ERRORS = 50;

export type BurnedStatus = "running" | "done" | "aborted" | "interrupted" | "error";

export interface WorkspaceScan {
  workspaceId: string;
  workspaceName: string;
  state: "pending" | "listing" | "stats" | "done" | "error";
  /** Inboxes on the chosen provider. */
  inboxes: number;
  /** Rows judged: inboxes for Google, domains for Microsoft. */
  counts: ScanCounts;
  error?: string;
}

export interface BurnedJob {
  id: string;
  label: string;
  status: BurnedStatus;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;

  esp: Esp;
  /** The thresholds as they were when the run started. */
  thresholds: Thresholds;
  start: string;
  end: string;

  workspaces: WorkspaceScan[];
  /** Every row judged, burned first. Capped so one run can't fill the disk. */
  rows: ScanRow[];
  rowsTruncated?: boolean;

  progress: {
    workspacesDone: number;
    workspacesTotal: number;
    inboxesRead: number;
    scanned: number;
    burned: number;
  };

  errors: string[];
  errorsTruncated?: boolean;
}

export interface BurnedStartPayload {
  esp: Esp;
  start: string;
  end: string;
}
