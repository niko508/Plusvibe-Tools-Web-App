// Shared types for Bulk Find & Replace Copy jobs (server + client).
//
// One edit, every campaign in the chosen workspaces, every step. Two phases
// with a confirmation between them:
//
//   scanning              read every campaign, work out what would change
//   awaiting_confirmation nothing written — the summary is on screen
//   applying              re-read each affected campaign and write it
//
// The scan's findings are only a summary. The apply re-reads every campaign
// and re-applies the edit from scratch (it is deterministic), and skips any
// campaign whose variation count changed in between.

import type { CopyEdit } from "@/lib/copy-sections/edit";

export const MAX_STORED_ERRORS = 50;

export type CopyReplaceStatus =
  | "scanning"
  | "awaiting_confirmation"
  | "applying"
  | "done"
  | "cancelled"
  | "aborted"
  | "interrupted"
  | "error";

export type CampaignState =
  | "pending"
  | "scanning"
  | "unchanged"
  | "would-change"
  | "applying"
  | "applied"
  | "skipped"
  | "error";

export interface CampaignOutcome {
  campaignId: string;
  campaignName: string;
  campaignType: "parent" | "subseq";
  status: string;
  state: CampaignState;
  /** Per step: how many variations would change / did change, of how many. */
  steps: { step: number; total: number; changed: number }[];
  /** Live variations across all steps at scan time — the stale guard. */
  liveVariations: number;
  changed: number;
  /** After apply: read back and confirmed. */
  verified?: boolean;
  unverified?: { step: number; variation: string }[];
  error?: string;
}

export interface WorkspaceOutcome {
  workspaceId: string;
  workspaceName: string;
  state: "pending" | "scanning" | "done" | "error";
  campaigns: CampaignOutcome[];
  /** Campaigns in the workspace that were out of scope (status / type). */
  skippedOutOfScope: number;
  error?: string;
}

export interface CopyReplaceJob {
  id: string;
  label: string;
  status: CopyReplaceStatus;
  createdAt: number;
  updatedAt: number;
  confirmedAt?: number;
  finishedAt?: number;

  edit: CopyEdit;
  includeSubsequences: boolean;
  workspaces: WorkspaceOutcome[];

  progress: {
    workspacesScanned: number;
    campaignsScanned: number;
    campaignsToChange: number;
    variationsToChange: number;
    campaignsApplied: number;
    campaignsFailed: number;
    campaignsSkipped: number;
  };

  errors: string[];
  errorsTruncated?: boolean;
}

export interface CopyReplaceStartPayload {
  workspaces: { id: string; name: string }[];
  edit: CopyEdit;
  includeSubsequences?: boolean;
}
