// Shared types for Auto-tag by Domain jobs (server + client).
//
// Every inbox in every selected workspace gets its TLD tag (from its email's
// domain) and its domain platform tag (from the "Domain Host" column of the
// 📋 Domains sheet), unless it already carries a tag from that set. Tags
// missing from a workspace are created first. Runs in the background.
//
// When asked, it also puts each inbox in the pool of the provider that sends
// it — and takes the other pool's tag off the ones carrying it, so the pools
// are true rather than merely populated.
//
// The three sets are independent, so a run can do any combination: the pool
// pass alone is what the "Tag by provider" button starts.

import type { TagInput } from "@/lib/tags/bulk-tags";
import type { PlanCounts } from "@/lib/tags/domain-tags";
import type { PoolCounts } from "@/lib/tags/pool-tags";

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
  /** The pool pass, when this run does one. */
  pools?: PoolCounts;
  /** Assignments made / that failed, over every set. */
  assigned: number;
  failed: number;
  /** "digital ×3" — TLDs seen that have no tag in the set. */
  unknownTlds?: string;
  /** "godaddy ×2" — sheet hosts that have no tag in the set. */
  unknownHosts?: string;
  verified?: { checked: number; lostTags: number; missingTag: number; stillTagged?: number };
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
  /** Whether this run also puts google-pool / microsoft-pool on by provider. */
  pools: boolean;
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
    /** Pool tags put on. */
    poolAssigned: number;
    /** Wrong pool tags taken off. */
    poolRemoved: number;
    /** Already in the right pool, nothing to do. */
    poolOk: number;
    /** On neither provider, left alone. */
    poolNone: number;
  };

  errors: string[];
  errorsTruncated?: boolean;
}

export interface DomainTagsStartPayload {
  workspaces: { id: string; name: string }[];
  tldTags: TagInput[];
  platformTags: TagInput[];
  /**
   * Also tag by provider: google-pool on Google mailboxes, microsoft-pool on
   * Microsoft ones. Independent of the two domain sets, so a run can do the
   * pools alone.
   */
  pools?: boolean;
  sheetUrl?: string;
  sheetTab?: string;
}
