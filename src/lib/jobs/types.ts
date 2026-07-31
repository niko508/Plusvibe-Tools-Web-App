// Shared bulk-delete job types, used by the client tool, the API routes, and
// the server-side job manager. No server-only imports so the client can use it.

export type JobStatus =
  | "running"
  | "done"
  | "aborted"
  | "interrupted"
  | "error";

// One inbox to delete.
export interface DeleteTask {
  workspace_id: string;
  email: string;
  domain: string;
}

export type DomainStatus =
  | "pending"
  | "running"
  | "done"
  | "partial"
  | "error";

// Per-domain rollup shown in the results.
export interface JobDomainRow {
  domain: string;
  total: number; // inboxes matched for this domain
  deleted: number;
  skipped: number; // already gone (treated as success)
  errors: number;
  status: DomainStatus;
}

export interface JobError {
  workspace_id: string;
  workspaceName?: string;
  email: string;
  reason: string;
}

export interface JobProgress {
  domainsTotal: number;
  domainsDone: number;
  inboxesTotal: number;
  inboxesAttempted: number;
  inboxesDeleted: number;
  inboxesSkipped: number;
  inboxesErrored: number;
}

// The persisted, client-facing record. Never contains the API key or the full
// task list (those live only in server memory while running).
export interface JobRecord {
  id: string;
  label: string;
  status: JobStatus;
  createdAt: number; // epoch ms
  updatedAt: number;
  scopeWorkspaces: string[]; // workspace names, for display
  progress: JobProgress;
  domains: JobDomainRow[];
  notFound: string[]; // pasted domains with no matching inbox
  errors: JobError[]; // capped
  errorsTruncated?: boolean;
}

// Payload the client posts to start a job. workspaceNames maps id -> name so we
// don't repeat the name on every task.
export interface StartJobPayload {
  label: string;
  workspaceNames: Record<string, string>;
  notFound: string[];
  tasks: DeleteTask[];
}

export const MAX_STORED_ERRORS = 500;
