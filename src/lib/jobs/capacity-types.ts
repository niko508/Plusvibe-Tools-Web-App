// Shared types for Sending Capacity runs (client + API routes + job manager).
// No server-only imports here.

import type { CapacityTotals, WorkspaceCapacity } from "@/lib/capacity/capacity";

export const MAX_STORED_ERRORS = 50;

export type CapacityStatus = "running" | "done" | "aborted" | "interrupted" | "error";

export interface CapacityJob {
  id: string;
  status: CapacityStatus;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;

  /** One per workspace that was counted, biggest sender first. */
  rows: WorkspaceCapacity[];
  totals: CapacityTotals;
  /** Workspaces left out by name, so their absence is never a mystery. */
  excluded: string[];

  progress: { done: number; total: number; inboxes: number };
  errors: string[];
  errorsTruncated?: boolean;
}
