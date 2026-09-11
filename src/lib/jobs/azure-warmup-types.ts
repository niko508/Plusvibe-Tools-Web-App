// Shared types for "Azure Start Warmup" background jobs. Used by the client
// tool, the API routes and the server manager — no server-only imports.

export type AzureJobStatus =
  | "waiting" // delay hasn't elapsed yet
  | "running"
  | "done"
  | "aborted"
  | "interrupted"
  | "error";

export type AzurePhase = "waiting" | "sheet" | "polling" | "finished";

export interface AzureDomainRow {
  domain: string;
  orderEmail: string;
  /** Inboxes for this domain in the upload. */
  total: number;
  /** Inboxes seen in Plusvibe so far. */
  found: number;
  /** Inboxes configured and switched to warming. */
  warmed: number;
  sheetUpdated: boolean;
  sheetNote?: string;
  /** ISO date written to "Warmup Started" once this domain began warming. */
  warmupStartedOn?: string;
}

export interface AzureSheetResult {
  attempted: boolean;
  rowsUpdated: number;
  /** Domains from the upload with no matching row in the sheet. */
  notFound: string[];
  error?: string;
}

export interface AzureTotals {
  domains: number;
  inboxes: number;
  found: number;
  warmed: number;
}

/** Client-facing record. The full email list stays on the server. */
export interface AzureWarmupJob {
  id: string;
  label: string;
  status: AzureJobStatus;
  phase: AzurePhase;
  createdAt: number;
  updatedAt: number;
  /** When polling begins (createdAt + delay). */
  startsAt: number;
  /** Hard stop — 7 days after polling begins. */
  deadlineAt: number;
  workspaceName: string;
  sheetTab: string;
  totals: AzureTotals;
  domains: AzureDomainRow[];
  sheet: AzureSheetResult;
  /** Uploaded inboxes still not present in Plusvibe. */
  missing: string[];
  /** Inboxes excluded because they errored elsewhere — never waited on. */
  ignored: string[];
  /** True only while a check is actually in flight, vs idling between checks. */
  checking: boolean;
  checks: number;
  lastCheckAt?: number;
  nextCheckAt?: number;
  errors: string[];
}

export interface AzureUploadRow {
  email: string;
  domain: string;
  orderEmail: string;
}

export interface AzureStartPayload {
  workspaceId: string;
  workspaceName: string;
  /** Minutes to wait before the first check. 0 starts immediately. */
  delayMinutes: number;
  sheetUrl: string;
  sheetTab: string;
  /** Tab the tenant provider is read from; defaults to DEFAULT_TENANTS_TAB. */
  tenantsTab?: string;
  rows: AzureUploadRow[];
  /** Emails to skip entirely (known-bad from the provisioning side). */
  ignoreEmails?: string[];
}

export const DEFAULT_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/1V9F5NwK_hPBeDHgHcIz5APDd3VFL1ckzrxCAnVvBQFU/edit";
export const DEFAULT_SHEET_TAB = "📋 Domains";

/** Column headers written in the Domains tab. */
export const COL_DOMAIN = "Domain";
export const COL_TENANT_EMAIL = "Tenant Email Address";
export const COL_STATUS = "Status";
export const COL_WARMUP_STARTED = "Warmup Started";
export const COL_WARMUP_DAYS = "Warmup Days";
export const COL_TENANT_SOURCE = "Tenant / Inbox Source";
export const STATUS_WARMING_UP = "Warming Up";

/**
 * The tab the tenant's provider is looked up in, and its two columns.
 *
 * A tenant email in the Domains tab is matched against this tab to fill in
 * "Tenant / Inbox Source", so the provider doesn't have to be typed in by hand
 * for every domain.
 */
export const DEFAULT_TENANTS_TAB = "👴 Tenants";
export const COL_TENANTS_EMAIL = "Tenant Email Address";
export const COL_TENANTS_PROVIDER = "Tenant Provider";

export const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly
export const MAX_RUN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const MAX_DELAY_HOURS = 72;
export const MAX_DELAY_MINUTES = MAX_DELAY_HOURS * 60;
/** Consecutive failed hourly checks before a run is treated as permanently broken. */
export const MAX_CONSECUTIVE_FAILURES = 24; // a full day of hourly checks
export const MAX_STORED_ERRORS = 100;
