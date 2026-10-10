// Shared types for Change Limits jobs (client + API routes + job manager).
// No server-only imports here.

import type { SettingsBlock, SettingsBundle } from "@/lib/change-limits/settings";
import type { ProviderBucket } from "@/lib/plusvibe-providers";

export type ChangeLimitsStatus =
  | "running"
  | "done"
  | "aborted"
  | "interrupted"
  | "error";

export type GroupState = "pending" | "running" | "done" | "partial" | "error";

/** One workspace's share of the run, for one provider. */
export interface ChangeLimitsGroup {
  workspaceId: string;
  workspaceName: string;
  /** Which senders these are, and so which settings they were given. */
  provider: ProviderBucket;
  total: number;
  updated: number;
  failed: number;
  state: GroupState;
  error?: string;
}

export interface ChangeLimitsProgress {
  workspacesTotal: number;
  workspacesDone: number;
  inboxesTotal: number;
  inboxesUpdated: number;
  inboxesFailed: number;
}

export interface ChangeLimitsJob {
  id: string;
  label: string;
  status: ChangeLimitsStatus;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  /** What was applied, one block per provider, resolved server-side. */
  settings: SettingsBlock[];
  groups: ChangeLimitsGroup[];
  progress: ChangeLimitsProgress;
  errors: string[];
  errorsTruncated?: boolean;
}

/** One inbox to update. The email is carried only so errors can name it. */
export interface ChangeLimitsInbox {
  id: string;
  email: string;
}

export interface ChangeLimitsTarget {
  workspaceId: string;
  workspaceName: string;
  /** Decides which of the bundle's settings these inboxes are given. */
  provider: ProviderBucket;
  inboxes: ChangeLimitsInbox[];
}

export interface ChangeLimitsStartPayload {
  settings: SettingsBundle;
  targets: ChangeLimitsTarget[];
}

export const MAX_STORED_ERRORS = 200;
/** Account ids per bulk-update call. */
export const UPDATE_CHUNK = 100;
