// Shared types for Change Campaign Settings jobs (server + client).
//
// One set of changes, every ACTIVE campaign in every selected workspace, in
// the background. Per campaign: compare what it has with what is wanted,
// write only the settings that differ, read it back to confirm.

import type { SettingChange } from "@/lib/campaign-settings/settings";

export const MAX_STORED_ERRORS = 50;

export type CampaignSettingsStatus = "running" | "done" | "aborted" | "interrupted" | "error";

export type CampaignState = "pending" | "updating" | "changed" | "already" | "error";

export interface CampaignOutcome {
  campaignId: string;
  campaignName: string;
  campaignType: "parent" | "subseq";
  state: CampaignState;
  /** The settings this campaign needed (differed from what was wanted). */
  needed: string[];
  /** After the write: read back and confirmed. */
  verified?: boolean;
  /** Settings that did not read back as wanted. */
  unverified?: string[];
  error?: string;
}

export interface WorkspaceOutcome {
  workspaceId: string;
  workspaceName: string;
  state: "pending" | "listing" | "updating" | "done" | "error";
  campaigns: CampaignOutcome[];
  /** Campaigns in the workspace that were not active. */
  skippedNotActive: number;
  error?: string;
}

export interface CampaignSettingsJob {
  id: string;
  label: string;
  status: CampaignSettingsStatus;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;

  changes: SettingChange[];
  includeSubsequences: boolean;
  workspaces: WorkspaceOutcome[];

  progress: {
    workspacesDone: number;
    /** Active campaigns found so far. */
    campaignsFound: number;
    campaignsDone: number;
    changed: number;
    already: number;
    failed: number;
  };

  errors: string[];
  errorsTruncated?: boolean;
}

export interface CampaignSettingsStartPayload {
  workspaces: { id: string; name: string }[];
  changes: SettingChange[];
  includeSubsequences?: boolean;
}
