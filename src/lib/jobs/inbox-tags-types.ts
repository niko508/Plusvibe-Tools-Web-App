// Shared types for Update Inbox & Campaign Tags jobs (server + client).
//
// One level (inboxes or campaigns), one action (add or remove), one set of
// rules, every selected workspace, in the background. Per workspace: read the
// tags, create any that are missing (adding only), read every inbox or
// campaign, sort them into buckets, move each rule's tag on or off the ones in
// its scope that aren't already that way, then re-read a sample to confirm
// nothing else changed.
//
// The job id stays "inbox-tags" — it is what the routes and the jobs
// directory are named, and records written before campaigns existed load as
// inbox jobs.

import type { BucketCounts, Level, ProviderCounts, Rule, TagAction } from "@/lib/inbox-tags/plan";

export const MAX_STORED_ERRORS = 50;

export type InboxTagsStatus = "running" | "done" | "aborted" | "interrupted" | "error";

export type WorkspaceState = "pending" | "tags" | "fetching" | "tagging" | "verifying" | "done" | "error";

export interface RuleOutcome {
  /** Index into the job's `rules`. */
  rule: number;
  tagId?: string;
  /** The tag was missing from this workspace and was created. */
  created?: boolean;
  /**
   * The workspace has no tag of that name. Removing one it never had is
   * nothing to do, not a failure.
   */
  noTag?: boolean;
  /** Inboxes or campaigns in scope. */
  matched: number;
  /** Already the way the rule wants them — left alone. */
  already: number;
  /** Changed by this job. */
  assigned: number;
  /** In scope, but the call failed. */
  failed: number;
  error?: string;
}

export interface WorkspaceOutcome {
  workspaceId: string;
  workspaceName: string;
  state: WorkspaceState;
  /** Inboxes or campaigns read so far (live during fetching), then the total. */
  found: number;
  /** How many fell in each bucket: providers for inboxes, statuses for campaigns. */
  buckets: BucketCounts;
  rules: RuleOutcome[];
  /** The re-read after writing. */
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

  level: Level;
  action: TagAction;
  /** Campaigns only: sub-sequences were tagged as well as their parents. */
  includeSubsequences?: boolean;
  rules: Rule[];
  workspaces: WorkspaceOutcome[];

  progress: {
    workspacesDone: number;
    /** Inboxes or campaigns read. */
    read: number;
    /** Tag writes made (something under two rules counts twice). */
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
  level?: Level;
  action?: TagAction;
  includeSubsequences?: boolean;
}

export type { ProviderCounts };
