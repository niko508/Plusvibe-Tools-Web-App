"use client";

import { getApiKey } from "@/lib/api-key";
import type { WebhookConfig } from "@/lib/webhooks/config";
import type { FollowUpTemplate } from "@/lib/follow-ups/templates";
import type {
  CampaignTypesJob,
  CampaignTypesStartPayload,
} from "@/lib/jobs/campaign-types-types";
import type {
  CampaignDetail,
  CampaignSummary,
  EmailAccountsResponse,
  EmailStatsResponse,
  WorkspacesResponse,
} from "@/lib/plusvibe-types";
import type { JobRecord, StartJobPayload } from "@/lib/jobs/types";
import type {
  Remove50Job,
  Remove50StartPayload,
  WarmupSettings,
} from "@/lib/jobs/remove-50-types";
import type {
  MoveLeadsJob,
  MoveLeadsStartPayload,
} from "@/lib/jobs/move-leads-types";
import type {
  AzureWarmupJob,
  AzureStartPayload,
} from "@/lib/jobs/azure-warmup-types";

export type { WarmupSettings } from "@/lib/jobs/remove-50-types";

// Header our proxy reads the forwarded key from. Mirrors CLIENT_KEY_HEADER on
// the server (kept as a literal here to avoid importing server-only code).
const KEY_HEADER = "x-pv-key";

export class ApiClientError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
  }
}

async function request<T>(
  url: string,
  init?: {
    method?: "GET" | "POST" | "PUT";
    body?: unknown;
    signal?: AbortSignal;
  }
): Promise<T> {
  const key = getApiKey();
  const headers: Record<string, string> = {};
  if (key) headers[KEY_HEADER] = key;
  if (init?.body !== undefined) headers["content-type"] = "application/json";

  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: init?.signal,
  });

  const text = await res.text();
  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!res.ok) {
    const message =
      (body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : undefined) || `Request failed (${res.status})`;
    throw new ApiClientError(message, res.status);
  }

  return body as T;
}

export function fetchWorkspaces(signal?: AbortSignal) {
  return request<WorkspacesResponse>("/api/plusvibe/workspaces", { signal });
}

export function fetchAccounts(
  params: { workspace_id: string; tags?: string },
  signal?: AbortSignal
) {
  const qs = new URLSearchParams({ workspace_id: params.workspace_id });
  if (params.tags) qs.set("tags", params.tags);
  return request<EmailAccountsResponse>(
    `/api/plusvibe/accounts?${qs.toString()}`,
    { signal }
  );
}

// Fetches a single page of accounts (paged mode), so callers can loop and show
// progress on large workspaces instead of blocking on one long request.
export function fetchAccountsPage(
  params: { workspace_id: string; skip: number; limit: number; tags?: string },
  signal?: AbortSignal
) {
  const qs = new URLSearchParams({
    workspace_id: params.workspace_id,
    paged: "1",
    skip: String(params.skip),
    limit: String(params.limit),
  });
  if (params.tags) qs.set("tags", params.tags);
  return request<{ accounts: EmailAccountsResponse["accounts"]; hasMore: boolean }>(
    `/api/plusvibe/accounts?${qs.toString()}`,
    { signal }
  );
}

// --- Campaigns / sequence variations ---------------------------------------

export function fetchCampaigns(
  params: { workspace_id: string },
  signal?: AbortSignal
) {
  const qs = new URLSearchParams({ workspace_id: params.workspace_id });
  return request<{ campaigns: CampaignSummary[] }>(
    `/api/plusvibe/campaigns?${qs.toString()}`,
    { signal }
  );
}

export function fetchCampaign(
  params: { workspace_id: string; campaign_id: string },
  signal?: AbortSignal
) {
  const qs = new URLSearchParams({
    workspace_id: params.workspace_id,
    campaign_id: params.campaign_id,
  });
  return request<CampaignDetail>(`/api/plusvibe/campaign?${qs.toString()}`, {
    signal,
  });
}

export interface AddVariationsResult {
  added: { variation: string; name: string }[];
  /** Variants skipped because an identical body is already on the step. */
  skipped: string[];
  /** Stale deleted variations cleared out of the sequence by this write. */
  droppedDeleted: number;
  /** Existing variations the caller chose not to keep. */
  droppedByChoice: number;
  subject: string;
  step: number;
  before: number;
  expected: number;
  actual: number;
  verified: boolean;
}

export function addCampaignVariations(
  params: {
    workspace_id: string;
    campaign_id: string;
    step: number;
    variants: { name: string; body: string }[];
    expectedVariationCount?: number;
    /** Existing variation letters to preserve; omit to keep them all. */
    keepVariations?: string[];
  },
  signal?: AbortSignal
) {
  return request<AddVariationsResult>("/api/plusvibe/campaign-variations", {
    method: "POST",
    body: params,
    signal,
  });
}

// --- Move leads between campaigns -------------------------------------------

export interface LeadsPreview {
  available: number;
  counts: { status: string; count: number }[];
}

export function fetchLeadsPreview(
  params: { workspace_id: string; campaign_id: string },
  signal?: AbortSignal
) {
  const qs = new URLSearchParams({
    workspace_id: params.workspace_id,
    campaign_id: params.campaign_id,
  });
  return request<LeadsPreview>(`/api/plusvibe/leads/preview?${qs.toString()}`, {
    signal,
  });
}

// --- Move-leads background jobs ---------------------------------------------

export function startMoveLeads(
  payload: MoveLeadsStartPayload,
  signal?: AbortSignal
) {
  return request<{ jobIds: string[] }>("/api/jobs/move-leads/start", {
    method: "POST",
    body: payload,
    signal,
  });
}

export function listMoveLeadsJobs(signal?: AbortSignal) {
  return request<{ jobs: MoveLeadsJob[] }>("/api/jobs/move-leads/list", {
    signal,
  });
}

export function getMoveLeadsJob(jobId: string, signal?: AbortSignal) {
  return request<MoveLeadsJob>(
    `/api/jobs/move-leads/status?jobId=${encodeURIComponent(jobId)}`,
    { signal }
  );
}

export function abortMoveLeads(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/move-leads/abort", {
    method: "POST",
    body: { jobId },
    signal,
  });
}

// --- Azure Start Warmup background jobs -------------------------------------

export interface AzureJobsResponse {
  jobs: AzureWarmupJob[];
  sheetWriting: { configured: boolean; serviceAccount: string | null };
}

export function startAzureWarmup(
  payload: AzureStartPayload,
  signal?: AbortSignal
) {
  return request<{ jobId: string }>("/api/jobs/azure-warmup/start", {
    method: "POST",
    body: payload,
    signal,
  });
}

export function listAzureWarmupJobs(signal?: AbortSignal) {
  return request<AzureJobsResponse>("/api/jobs/azure-warmup/list", { signal });
}

export function abortAzureWarmup(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/azure-warmup/abort", {
    method: "POST",
    body: { jobId },
    signal,
  });
}

export function ignoreAzureWarmupInboxes(
  params: { jobId: string; emails: string[] },
  signal?: AbortSignal
) {
  return request<{ removed: number }>("/api/jobs/azure-warmup/ignore", {
    method: "POST",
    body: params,
    signal,
  });
}

export function resumeAzureWarmup(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/azure-warmup/resume", {
    method: "POST",
    body: { jobId },
    signal,
  });
}

export function deleteBulkDeleteJob(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/bulk-delete/delete", {
    method: "POST",
    body: { jobId },
    signal,
  });
}

export function deleteRemove50Job(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/remove-50/delete", {
    method: "POST",
    body: { jobId },
    signal,
  });
}

export function deleteMoveLeadsJob(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/move-leads/delete", {
    method: "POST",
    body: { jobId },
    signal,
  });
}

export function deleteAzureWarmupJob(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/azure-warmup/delete", {
    method: "POST",
    body: { jobId },
    signal,
  });
}

export interface TagsResponse {
  tags: { id: string; name: string }[];
}

export function fetchTags(
  params: { workspace_id: string },
  signal?: AbortSignal
) {
  const qs = new URLSearchParams({ workspace_id: params.workspace_id });
  return request<TagsResponse>(`/api/plusvibe/tags?${qs.toString()}`, { signal });
}

export interface EmailStatsParams {
  workspace_id: string;
  start_date: string;
  end_date: string;
  email_acc_id?: string;
  provider?: string;
  tags?: string;
  recp_provider?: string;
  domain?: string;
}

export function fetchEmailStats(params: EmailStatsParams, signal?: AbortSignal) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v) qs.set(k, v);
  }
  return request<EmailStatsResponse>(
    `/api/plusvibe/email-stats?${qs.toString()}`,
    { signal }
  );
}

// --- Bulk-delete (Remove Inboxes) background jobs ---------------------------

export function startBulkDelete(payload: StartJobPayload, signal?: AbortSignal) {
  return request<{ jobId: string }>("/api/jobs/bulk-delete/start", {
    method: "POST",
    body: payload,
    signal,
  });
}

export function getBulkDeleteJob(jobId: string, signal?: AbortSignal) {
  return request<JobRecord>(
    `/api/jobs/bulk-delete/status?jobId=${encodeURIComponent(jobId)}`,
    { signal }
  );
}

export function listBulkDeleteJobs(signal?: AbortSignal) {
  return request<{ jobs: JobRecord[] }>("/api/jobs/bulk-delete/list", {
    signal,
  });
}

export function abortBulkDelete(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/bulk-delete/abort", {
    method: "POST",
    body: { jobId },
    signal,
  });
}

// --- Email Infra Google Sheet ----------------------------------------------

export interface SheetMapResponse {
  map: Record<string, string>; // normalized domain -> client
  domains: number;
  clients: number;
}

export function fetchSheetMap(
  params: { url: string; tab: string },
  signal?: AbortSignal
) {
  const qs = new URLSearchParams({ url: params.url, tab: params.tab });
  return request<SheetMapResponse>(`/api/sheet?${qs.toString()}`, { signal });
}

// --- Bulk signature update -------------------------------------------------

export function bulkUpdateSignature(
  params: { workspace_id: string; ids: string[]; signature: string },
  signal?: AbortSignal
) {
  return request<{ status?: string }>("/api/plusvibe/bulk-update", {
    method: "POST",
    body: params,
    signal,
  });
}

// --- Delete + warmup settings (Remove 50 tool) -----------------------------

export function deleteAccount(
  params: { workspace_id: string; email: string },
  signal?: AbortSignal
) {
  return request<{ status?: string }>("/api/plusvibe/account-delete", {
    method: "POST",
    body: params,
    signal,
  });
}

// WarmupSettings is defined in @/lib/jobs/remove-50-types and re-exported above.

export function updateWarmupSettings(
  params: { workspace_id: string; ids: string[]; settings: WarmupSettings },
  signal?: AbortSignal
) {
  return request<{ status?: string }>("/api/plusvibe/bulk-update", {
    method: "POST",
    body: { workspace_id: params.workspace_id, ids: params.ids, ...params.settings },
    signal,
  });
}

export function setWarmupStatus(
  params: { workspace_id: string; ids: string[]; warmup_status: "ACTIVE" | "INACTIVE" },
  signal?: AbortSignal
) {
  return request<{ status?: string }>("/api/plusvibe/warmup-status", {
    method: "POST",
    body: params,
    signal,
  });
}

// --- Remove 50 background jobs ---------------------------------------------

export function startRemove50(payload: Remove50StartPayload, signal?: AbortSignal) {
  return request<{ jobId: string }>("/api/jobs/remove-50/start", {
    method: "POST",
    body: payload,
    signal,
  });
}

export function getRemove50Job(jobId: string, signal?: AbortSignal) {
  return request<Remove50Job>(
    `/api/jobs/remove-50/status?jobId=${encodeURIComponent(jobId)}`,
    { signal }
  );
}

export function listRemove50Jobs(signal?: AbortSignal) {
  return request<{ jobs: Remove50Job[] }>("/api/jobs/remove-50/list", { signal });
}

export function abortRemove50(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/remove-50/abort", {
    method: "POST",
    body: { jobId },
    signal,
  });
}

// --- Create All Campaign Types ---------------------------------------------

export function startCampaignTypes(
  payload: CampaignTypesStartPayload,
  signal?: AbortSignal
) {
  return request<{ jobId: string }>("/api/jobs/campaign-types/start", {
    method: "POST",
    body: payload,
    signal,
  });
}

export function listCampaignTypesJobs(signal?: AbortSignal) {
  return request<{ jobs: CampaignTypesJob[] }>("/api/jobs/campaign-types/list", {
    signal,
  });
}

export function getCampaignTypesJob(jobId: string, signal?: AbortSignal) {
  return request<{ job: CampaignTypesJob }>(
    `/api/jobs/campaign-types/status?jobId=${encodeURIComponent(jobId)}`,
    { signal }
  );
}

export function abortCampaignTypes(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/campaign-types/abort", {
    method: "POST",
    body: { jobId },
    signal,
  });
}

export function deleteCampaignTypesJob(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/campaign-types/delete", {
    method: "POST",
    body: { jobId },
    signal,
  });
}

// --- Create Follow Up Emails -------------------------------------------------

export function fetchFollowUpTemplates(signal?: AbortSignal) {
  return request<{ templates: FollowUpTemplate[]; seeded: boolean }>(
    "/api/follow-ups/templates",
    { signal }
  );
}

export function saveFollowUpTemplates(
  templates: FollowUpTemplate[],
  signal?: AbortSignal
) {
  return request<{ templates: FollowUpTemplate[] }>("/api/follow-ups/templates", {
    method: "PUT",
    body: { templates },
    signal,
  });
}

export interface FollowUpPlanRow {
  variation: string;
  name: string;
  position: number;
  replacements: number;
  preview: string;
}

export interface FollowUpPlan {
  campaignName: string;
  step: number;
  stepCreated: boolean;
  waitTime: number;
  existing: number;
  adding: FollowUpPlanRow[];
  skipped: number[];
  droppedDeleted: number;
  warnings: string[];
  applied: boolean;
  unchanged?: boolean;
  expected?: number;
  actual?: number;
  verified?: boolean;
}

export function applyFollowUps(
  params: {
    workspace_id: string;
    campaign_id: string;
    offer: string;
    templates: FollowUpTemplate[];
    waitTime?: number;
    dryRun?: boolean;
  },
  signal?: AbortSignal
) {
  return request<FollowUpPlan>("/api/follow-ups/apply", {
    method: "POST",
    body: params,
    signal,
  });
}

// --- General Bulk Actions ----------------------------------------------------

export interface BulkWebhookResult {
  workspaceId: string;
  workspaceName: string;
  outcome: "added" | "already" | "error";
  hookId?: string;
  reason?: string;
}

export interface BulkWebhookResponse {
  dryRun: boolean;
  results: BulkWebhookResult[];
  totals: { added: number; already: number; errors: number };
}

export function addWebhookToWorkspaces(
  params: {
    workspaces: { id: string; name: string }[];
    config: WebhookConfig;
    dryRun?: boolean;
  },
  signal?: AbortSignal
) {
  return request<BulkWebhookResponse>("/api/bulk-actions/webhooks", {
    method: "POST",
    body: params,
    signal,
  });
}

export interface MergedLeadLabel {
  key: string;
  name: string;
  sentiment: string;
  isSystem: boolean;
  eventType: string;
  /** How many of the requested workspaces expose this label. */
  presentIn: number;
}

export function fetchLeadLabels(workspaceIds: string[], signal?: AbortSignal) {
  const qs = new URLSearchParams({ workspace_ids: workspaceIds.join(",") });
  return request<{
    labels: MergedLeadLabel[];
    workspacesRead: number;
    workspacesRequested: number;
    failed: string[];
  }>(`/api/bulk-actions/lead-labels?${qs.toString()}`, { signal });
}
