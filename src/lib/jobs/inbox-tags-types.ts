// Shared types for Update Inbox Tags jobs (server + client).
//
// One set of rules, every selected workspace, in the background. Per
// workspace: read the tags, create any that are missing, read every inbox,
// sort them by provider, assign each rule's tag to the inboxes in its scope
// that don't already carry it, then re-read a sample to confirm nothing lost
// a tag it had.

import type { Rule, ProviderCounts } from "@/lib/inbox-tags/plan";

export const MAX_STORED_ERRORS = 50;

export type InboxTagsStatus = "running" | "done" | "aborted" | "interrupted" | "error";

export type WorkspaceState = "pending" | "tags" | "fetching" | "tagging" | "verifying" | "done" | "error";

export interface RuleOutcome {
  /** Index into the job's `rules`. */
  rule: number;
  tagId?: string;
  /** The tag was missing from this workspace and was created. */
  created?: boolean;
  /** Inboxes in scope. */
  matched: number;
  /** Already carried the tag — left alone. */
  already: number;
  /** Assigned by this job. */
  assigned: number;
  /** In scope, but the assign call failed. */
  failed: number;
  error?: string;
}

export interface WorkspaceOutcome {
  workspaceId: string;
  workspaceName: string;
  state: WorkspaceState;
  /** Inboxes read so far (live during fetching), then the total. */
  inboxes: number;
  providers: ProviderCounts;
  rules: RuleOutcome[];
  /** The re-read after assigning. */
  verified?: { checked: number; lostTags: number; missingTag: number };
  error?: string;
}

export interface InboxTagsJob {
  id: string;
  label: string;
  status: InboxTagsStatus;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;

  rules: Rule[];
  workspaces: WorkspaceOutcome[];

  progress: {
    workspacesDone: number;
    inboxesRead: number;
    /** Tag assignments made (an inbox under two rules counts twice). */
    assigned: number;
    already: number;
    failed: number;
    tagsCreated: number;
  };

  errors: string[];
  errorsTruncated?: boolean;
}

export interface InboxTagsStartPayload {
  workspaces: { id: string; name: string }[];
  rules: Rule[];
}
