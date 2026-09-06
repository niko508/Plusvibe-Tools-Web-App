"use client";

import { getApiKey } from "@/lib/api-key";
import type { WebhookConfig } from "@/lib/webhooks/config";
import type { Sentiment } from "@/lib/lead-labels/custom-label";
import type { CopyEdit } from "@/lib/copy-sections/edit";
import type { TagInput, TagSpec } from "@/lib/tags/bulk-tags";
import type { CopyReplaceJob, CopyReplaceStartPayload } from "@/lib/jobs/copy-replace-types";
import type { InboxTagsJob, InboxTagsStartPayload } from "@/lib/jobs/inbox-tags-types";
import type { CampaignSettingsJob, CampaignSettingsStartPayload } from "@/lib/jobs/campaign-settings-types";
import type { DomainTagsJob, DomainTagsStartPayload } from "@/lib/jobs/domain-tags-types";
import type { CatalogTag } from "@/lib/inbox-tags/plan";
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
import type {
  FirstCampaignJob,
  FirstCampaignStartPayload,
} from "@/lib/jobs/first-campaign-types";
import type { BlockedDomainsView } from "@/lib/jobs/blocked-domains-types";
import type {
  PauseCampaignsStartPayload,
  PauseCampaignsView,
  PausePlan,
} from "@/lib/jobs/pause-campaigns-types";

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
    method?: "GET" | "POST" | "PUT" | "DELETE";
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
  params: { workspace_id: string; campaign_type?: "all" | "parent" | "subseq" },
  signal?: AbortSignal
) {
  const qs = new URLSearchParams({ workspace_id: params.workspace_id });
  if (params.campaign_type) qs.set("campaign_type", params.campaign_type);
  return request<{ campaigns: CampaignSummary[] }>(
    `/api/plusvibe/campaigns?${qs.toString()}`,
    { signal }
  );
}

// --- Add Tags -----------------------------------------------------------------

export interface BulkTagResult {
  workspaceId: string;
  workspaceName: string;
  tag: string;
  outcome: "created" | "already" | "error";
  existingName?: string;
  tagId?: string;
  reason?: string;
}

export interface BulkTagsResponse {
  dryRun: boolean;
  tags: TagSpec[];
  duplicatesDropped: number;
  results: BulkTagResult[];
  totals: { created: number; already: number; errors: number };
}

export function addTagsToWorkspaces(
  params: {
    workspaces: { id: string; name: string }[];
    tags: TagInput[];
    dryRun?: boolean;
  },
  signal?: AbortSignal
) {
  return request<BulkTagsResponse>("/api/bulk-actions/tags", { method: "POST", body: params, signal });
}

// --- Bulk Find & Replace Copy ------------------------------------------------

export function startCopyReplace(payload: CopyReplaceStartPayload, signal?: AbortSignal) {
  return request<{ jobId: string }>("/api/jobs/copy-replace/start", { method: "POST", body: payload, signal });
}
export function listCopyReplaceJobs(signal?: AbortSignal) {
  return request<{ jobs: CopyReplaceJob[] }>("/api/jobs/copy-replace/list", { signal });
}
export function confirmCopyReplace(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/copy-replace/confirm", { method: "POST", body: { jobId }, signal });
}
export function cancelCopyReplace(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/copy-replace/cancel", { method: "POST", body: { jobId }, signal });
}
export function abortCopyReplace(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/copy-replace/abort", { method: "POST", body: { jobId }, signal });
}
export function deleteCopyReplaceJob(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/copy-replace/delete", { method: "POST", body: { jobId }, signal });
}

// --- Update Inbox Tags -------------------------------------------------------

export interface TagCatalogResponse {
  tags: CatalogTag[];
  read: number;
  failed: { workspaceId: string; workspaceName: string; reason: string }[];
}

/** The tags in use across these workspaces, merged by name. */
export function fetchTagCatalog(workspaces: { id: string; name: string }[], signal?: AbortSignal) {
  return request<TagCatalogResponse>("/api/bulk-actions/tag-catalog", { method: "POST", body: { workspaces }, signal });
}
export function startInboxTags(payload: InboxTagsStartPayload, signal?: AbortSignal) {
  return request<{ jobId: string }>("/api/jobs/inbox-tags/start", { method: "POST", body: payload, signal });
}
export function listInboxTagsJobs(signal?: AbortSignal) {
  return request<{ jobs: InboxTagsJob[] }>("/api/jobs/inbox-tags/list", { signal });
}
export function abortInboxTagsJob(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/inbox-tags/abort", { method: "POST", body: { jobId }, signal });
}
export function deleteInboxTagsJob(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/inbox-tags/delete", { method: "POST", body: { jobId }, signal });
}

// --- Auto-tag by Domain -----------------------------------------------------

export function startDomainTags(payload: DomainTagsStartPayload, signal?: AbortSignal) {
  return request<{ jobId: string }>("/api/jobs/domain-tags/start", { method: "POST", body: payload, signal });
}
export function listDomainTagsJobs(signal?: AbortSignal) {
  return request<{ jobs: DomainTagsJob[] }>("/api/jobs/domain-tags/list", { signal });
}
export function abortDomainTagsJob(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/domain-tags/abort", { method: "POST", body: { jobId }, signal });
}
export function deleteDomainTagsJob(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/domain-tags/delete", { method: "POST", body: { jobId }, signal });
}

// --- Change Campaign Settings ------------------------------------------------

export function startCampaignSettings(payload: CampaignSettingsStartPayload, signal?: AbortSignal) {
  return request<{ jobId: string }>("/api/jobs/campaign-settings/start", { method: "POST", body: payload, signal });
}
export function listCampaignSettingsJobs(signal?: AbortSignal) {
  return request<{ jobs: CampaignSettingsJob[] }>("/api/jobs/campaign-settings/list", { signal });
}
export function abortCampaignSettingsJob(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/campaign-settings/abort", { method: "POST", body: { jobId }, signal });
}
export function deleteCampaignSettingsJob(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/campaign-settings/delete", { method: "POST", body: { jobId }, signal });
}

// --- Change Email Copy Sections ---------------------------------------------

export interface CopySectionResult {
  variation: string;
  changed: boolean;
  reason?: string;
  subjectBefore: string;
  subjectAfter: string;
  bodyBefore: string;
  bodyAfter: string;
  textBefore: string;
  textAfter: string;
  subjectMatches: number;
  bodyMatches: number;
}

export interface CopySectionsResponse {
  step: number;
  campaignName: string;
  total: number;
  changed: number;
  droppedDeleted: number;
  results: CopySectionResult[];
  dryRun: boolean;
  written: boolean;
  verified: boolean;
  unverified: string[];
}

export function editCopySections(
  params: {
    workspace_id: string;
    campaign_id: string;
    step: number;
    edit: CopyEdit;
    dryRun?: boolean;
    expectedVariationCount?: number;
  },
  signal?: AbortSignal
) {
  return request<CopySectionsResponse>("/api/plusvibe/copy-sections", {
    method: "POST",
    body: params,
    signal,
  });
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

export interface BulkLabelResult {
  workspaceId: string;
  workspaceName: string;
  outcome: "created" | "already" | "conflict" | "error";
  existingName?: string;
  matchedBy?: "exact" | "similar";
  key?: string;
  reason?: string;
}

export interface BulkLabelResponse {
  dryRun: boolean;
  name: string;
  sentiment: Sentiment;
  results: BulkLabelResult[];
  totals: {
    created: number;
    already: number;
    conflict: number;
    errors: number;
  };
}

export function addLeadLabelToWorkspaces(
  params: {
    workspaces: { id: string; name: string }[];
    name: string;
    sentiment: Sentiment;
    dryRun?: boolean;
  },
  signal?: AbortSignal
) {
  return request<BulkLabelResponse>("/api/bulk-actions/lead-labels", {
    method: "POST",
    body: params,
    signal,
  });
}

export interface BulkFieldResult {
  workspaceId: string;
  workspaceName: string;
  outcome: "created" | "already" | "conflict" | "error";
  existingName?: string;
  existingDefault?: string;
  reason?: string;
}

export interface BulkFieldResponse {
  dryRun: boolean;
  name: string;
  normalizedName: string;
  defaultValue?: string;
  results: BulkFieldResult[];
  totals: {
    created: number;
    already: number;
    conflict: number;
    errors: number;
  };
}

// --- Pause Campaigns --------------------------------------------------------

export function planPauseCampaigns(
  params: { workspaces: { id: string; name: string }[]; resumeAt?: number },
  signal?: AbortSignal
) {
  return request<PausePlan>("/api/jobs/pause-campaigns/start", {
    method: "POST",
    body: { ...params, dryRun: true },
    signal,
  });
}

export function startPauseCampaigns(
  payload: PauseCampaignsStartPayload,
  signal?: AbortSignal
) {
  return request<{ jobId: string }>("/api/jobs/pause-campaigns/start", {
    method: "POST",
    body: payload,
    signal,
  });
}

export function listPauseCampaignsJobs(signal?: AbortSignal) {
  return request<PauseCampaignsView>("/api/jobs/pause-campaigns/list", { signal });
}

export function abortPauseCampaigns(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/pause-campaigns/abort", {
    method: "POST",
    body: { jobId },
    signal,
  });
}

export function deletePauseCampaignsJob(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/pause-campaigns/delete", {
    method: "POST",
    body: { jobId },
    signal,
  });
}

export function resumePauseCampaignsNow(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/pause-campaigns/resume", {
    method: "POST",
    body: { jobId },
    signal,
  });
}

export function cancelPauseCampaignsResume(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/pause-campaigns/cancel-resume", {
    method: "POST",
    body: { jobId },
    signal,
  });
}

export function addFieldToWorkspaces(
  params: {
    workspaces: { id: string; name: string }[];
    name: string;
    defaultValue?: string;
    dryRun?: boolean;
  },
  signal?: AbortSignal
) {
  return request<BulkFieldResponse>("/api/bulk-actions/additional-fields", {
    method: "POST",
    body: params,
    signal,
  });
}

// --- Add Signatures presets --------------------------------------------------

export interface SignaturePreset {
  titles: string[];
  companies: string[];
  phones: string[];
  addresses: string[];
  savedAt: number;
}

export function fetchSignaturePreset(workspaceId: string, signal?: AbortSignal) {
  const qs = new URLSearchParams({ workspace_id: workspaceId });
  return request<{ preset: SignaturePreset | null }>(
    `/api/signatures/presets?${qs.toString()}`,
    { signal }
  );
}

export function saveSignaturePreset(
  params: {
    workspaceId: string;
    titles: string[];
    companies: string[];
    phones: string[];
    addresses: string[];
  },
  signal?: AbortSignal
) {
  return request<{ preset: SignaturePreset }>("/api/signatures/presets", {
    method: "PUT",
    body: params,
    signal,
  });
}

export function deleteSignaturePreset(workspaceId: string, signal?: AbortSignal) {
  const qs = new URLSearchParams({ workspace_id: workspaceId });
  return request<{ ok: boolean }>(`/api/signatures/presets?${qs.toString()}`, {
    method: "DELETE",
    signal,
  });
}

// --- New Workspace 1st Campaign ---------------------------------------------

export function startFirstCampaign(
  payload: FirstCampaignStartPayload,
  signal?: AbortSignal
) {
  return request<{ jobId: string }>("/api/jobs/first-campaign/start", {
    method: "POST",
    body: payload,
    signal,
  });
}

export function listFirstCampaignJobs(signal?: AbortSignal) {
  return request<{ jobs: FirstCampaignJob[] }>("/api/jobs/first-campaign/list", {
    signal,
  });
}

export function getFirstCampaignJob(jobId: string, signal?: AbortSignal) {
  return request<{ job: FirstCampaignJob }>(
    `/api/jobs/first-campaign/status?jobId=${encodeURIComponent(jobId)}`,
    { signal }
  );
}

export function abortFirstCampaign(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/first-campaign/abort", {
    method: "POST",
    body: { jobId },
    signal,
  });
}

export function deleteFirstCampaignJob(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/first-campaign/delete", {
    method: "POST",
    body: { jobId },
    signal,
  });
}

// --- Blocked Domains ---------------------------------------------------------

export function fetchBlockedDomains(signal?: AbortSignal) {
  return request<BlockedDomainsView>("/api/jobs/blocked-domains/list", {
    signal,
  });
}

export function setBlockedDomainAutoDelete(
  autoDelete: boolean,
  signal?: AbortSignal
) {
  return request<{ settings: { autoDelete: boolean } }>(
    "/api/jobs/blocked-domains/settings",
    { method: "PUT", body: { autoDelete }, signal }
  );
}

export function confirmBlockedDomain(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/blocked-domains/confirm", {
    method: "POST",
    body: { jobId },
    signal,
  });
}

export function dismissBlockedDomain(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/blocked-domains/dismiss", {
    method: "POST",
    body: { jobId },
    signal,
  });
}

export function rearmBlockedDomain(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/blocked-domains/rearm", {
    method: "POST",
    body: { jobId },
    signal,
  });
}

export function deleteBlockedDomainJob(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/blocked-domains/delete", {
    method: "POST",
    body: { jobId },
    signal,
  });
}
