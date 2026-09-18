// Shared types for Auto-tag by Domain jobs (server + client).
//
// Every inbox in every selected workspace gets its TLD tag (from its email's
// domain) and its domain platform tag (from the "Domain Host" column of the
// 📋 Domains sheet), unless it already carries a tag from that set. Tags
// missing from a workspace are created first. Runs in the background.

import type { TagInput } from "@/lib/tags/bulk-tags";
import type { PlanCounts } from "@/lib/tags/domain-tags";

export const MAX_STORED_ERRORS = 50;

export type DomainTagsStatus = "running" | "done" | "aborted" | "interrupted" | "error";

export type WorkspaceState = "pending" | "tags" | "fetching" | "tagging" | "verifying" | "done" | "error";

export interface WorkspaceOutcome {
  workspaceId: string;
  workspaceName: string;
  state: WorkspaceState;
  /** Inboxes read so far (live during fetching), then the total. */
  inboxes: number;
  /** Tags created because the workspace lacked them. */
  tagsCreated: string[];
  counts: PlanCounts;
  /** Assignments made / that failed, over both sets. */
  assigned: number;
  failed: number;
  /** "digital ×3" — TLDs seen that have no tag in the set. */
  unknownTlds?: string;
  /** "godaddy ×2" — sheet hosts that have no tag in the set. */
  unknownHosts?: string;
  verified?: { checked: number; lostTags: number; missingTag: number };
  error?: string;
}

export interface DomainTagsJob {
  id: string;
  label: string;
  status: DomainTagsStatus;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;

  tldTags: TagInput[];
  platformTags: TagInput[];
  sheetUrl?: string;
  sheetTab?: string;
  /** How the sheet read went, once it has. */
  sheet?: { domains: number; withHost: number; note?: string };
  workspaces: WorkspaceOutcome[];

  progress: {
    workspacesDone: number;
    inboxesRead: number;
    tldAssigned: number;
    tldHad: number;
    tldNoTag: number;
    platformAssigned: number;
    platformHad: number;
    notInSheet: number;
    hostNoTag: number;
    failed: number;
    tagsCreated: number;
  };

  errors: string[];
  errorsTruncated?: boolean;
}

export interface DomainTagsStartPayload {
  workspaces: { id: string; name: string }[];
  tldTags: TagInput[];
  platformTags: TagInput[];
  sheetUrl?: string;
  sheetTab?: string;
}
