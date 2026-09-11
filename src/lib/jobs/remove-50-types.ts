// Shared types for the "Remove 50 Inboxes from Domain" background jobs. Used by
// the client tool, the API routes, and the server-side job manager — so NO
// server-only imports here.

// Warmup fields forwarded to PUT /account/bulk-update (whitelisted server-side).
// Lives here (a neutral module) so both client and server can import it.
export interface WarmupSettings {
  warmup_max_daily_limit?: number;
  bulk_warmup_is_slow_rampup?: "yes" | "no";
  warmup_initial_daily_limit?: number;
  warmup_pace_increment?: number;
  warmup_randomize?: "yes" | "no";
  warmup_randomize_num?: number;
  warmup_reply_rate?: number;
  warmup_schedule?: {
    tz: string;
    from_time: string;
    to_time: string;
    days: string[];
  };
  warmup_business_type?: string;
}

export type Remove50JobStatus =
  | "running"
  | "done"
  | "aborted"
  | "interrupted"
  | "error";

export type Remove50DomainStatus =
  | "pending"
  | "deleting"
  | "configuring"
  | "done"
  | "partial"
  | "error";

// Per-domain rollup shown in the job's results.
export interface Remove50DomainRow {
  domain: string;
  total: number; // inboxes before trimming
  toDelete: number;
  keep: number;
  deleted: number;
  deleteErrors: number;
  configured: boolean; // warmup settings applied
  warmupEnabled: boolean; // warmup status set to ACTIVE
  businessTypeSkipped: boolean; // API rejected the business type, applied without it
  status: Remove50DomainStatus;
  error?: string;
}

export interface Remove50JobError {
  domain: string;
  email?: string; // present for delete-phase errors
  phase: "delete" | "configure";
  reason: string;
}

export interface Remove50Progress {
  domainsTotal: number;
  domainsDone: number;
  inboxesToDelete: number;
  inboxesDeleted: number;
  inboxesSkipped: number; // already gone (treated as success)
  inboxesErrored: number;
  domainsConfigured: number;
}

// The persisted, client-facing job record. Never contains the API key, the
// warmup settings, or the full email/id lists (those live only in server memory
// while the job runs).
export interface Remove50Job {
  id: string;
  label: string;
  status: Remove50JobStatus;
  createdAt: number; // epoch ms
  updatedAt: number;
  workspaceName: string;
  target: number;
  phase: "deleting" | "configuring" | "finished";
  progress: Remove50Progress;
  domains: Remove50DomainRow[];
  businessTypeSkipped: number; // count of domains where business type was skipped
  errors: Remove50JobError[]; // capped
  errorsTruncated?: boolean;
}

// One trimmed domain's plan: which inboxes to delete, which ids to keep+config.
export interface Remove50DomainPlan {
  domain: string;
  total: number; // inboxes before trimming (for the row)
  deleteEmails: string[];
  keepIds: string[];
}

// Payload the client posts to start a job.
export interface Remove50StartPayload {
  label: string;
  workspaceId: string;
  workspaceName: string;
  target: number;
  settings: WarmupSettings;
  domains: Remove50DomainPlan[];
}

export const MAX_STORED_ERRORS = 500;
