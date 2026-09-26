"use client";

import { getApiKey } from "@/lib/api-key";
import type { WebhookConfig } from "@/lib/webhooks/config";
import type { Sentiment } from "@/lib/lead-labels/custom-label";
import type { CopyEdit } from "@/lib/copy-sections/edit";
import type { TagInput, TagSpec } from "@/lib/tags/bulk-tags";
import type { CopyReplaceJob, CopyReplaceStartPayload } from "@/lib/jobs/copy-replace-types";
import type { InboxTagsJob, InboxTagsStartPayload } from "@/lib/jobs/inbox-tags-types";
import type { ChangeLimitsJob, ChangeLimitsStartPayload } from "@/lib/jobs/change-limits-types";
import type { CampaignSettingsJob, CampaignSettingsStartPayload } from "@/lib/jobs/campaign-settings-types";
import type { DomainTagsJob, DomainTagsStartPayload } from "@/lib/jobs/domain-tags-types";
import type { StartOutreachJob, StartOutreachStartPayload } from "@/lib/jobs/start-outreach-types";
import type { ScheduledSwitch } from "@/lib/jobs/outreach-schedule-types";
import type { CapacityJob } from "@/lib/jobs/capacity-types";
import type { OutreachSettings } from "@/lib/start-outreach/week-settings";
import type { CatalogTag } from "@/lib/inbox-tags/plan";
import type { FollowUpTemplate } from "@/lib/follow-ups/templates";
import type {
  CampaignTypesJob,
  CampaignTypesStartPayload,
} from "@/lib/jobs/campaign-types-types";
import type { BurnedJob, BurnedStartPayload } from "@/lib/jobs/burned-types";
import type { BurnedRemovalJob, RemovalStartPayload } from "@/lib/jobs/burned-removal-types";
import type { BurnedSettings, Esp } from "@/lib/burned/settings";
import type { WeekSchedule } from "@/lib/campaign-settings/schedule";
import type {
  Profile,
  ProfileKey,
  RotationSettings,
  SetupInput,
  WorkspaceRotation,
} from "@/lib/inbox-rotation/settings";
import type { Position } from "@/lib/inbox-rotation/schedule";
import type {
  CampaignDetail,
  CampaignSummary,
  EmailAccountsResponse,
  EmailStatsResponse,
  WorkspacesResponse,
} from "@/lib/plusvibe-types";
import type { JobRecord, StartJobPayload } from "@/lib/jobs/types";
import type {
  MoveLeadsJob,
  MoveLeadsStartPayload,
} from "@/lib/jobs/move-leads-types";
import type {
  AzureWarmupJob,
  AzureStartPayload,
} from "@/lib/jobs/azure-warmup-types";
import type { WarmupSettings as AzureWarmupSettings } from "@/lib/azure-warmup/warmup-settings";
import type { InboxRules } from "@/lib/blocked-inboxes/rules";
import type { GeneralSettings } from "@/lib/general-settings/settings";
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

// --- Add / Remove Tags ---------------------------------------------------------

export interface BulkTagResult {
  workspaceId: string;
  workspaceName: string;
  tag: string;
  outcome: "created" | "already" | "error" | "removed" | "missing";
  existingName?: string;
  tagId?: string;
  reason?: string;
}

export interface BulkTagsResponse {
  dryRun: boolean;
  mode?: "add" | "remove";
  tags: TagSpec[];
  duplicatesDropped: number;
  results: BulkTagResult[];
  totals: { created: number; already: number; removed?: number; missing?: number; errors: number };
}

/** Adds tags, or removes them when `mode` says so. */
export function addTagsToWorkspaces(
  params: {
    workspaces: { id: string; name: string }[];
    tags: TagInput[];
    mode?: "add" | "remove";
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

// --- Start Outreach with New Inboxes ----------------------------------------

export interface WarmupDatesResponse {
  /** domain → the sheet's Warmup Started / Warmup Days / Domain Host / Client cells. */
  byDomain: Record<string, { started?: string; days?: string | number; host?: string; client?: string }>;
  rows: number;
  /** Which sheet was read, in words, or null when none could be. */
  source: string | null;
  problem: string | null;
}

/** The Domains tab's warmup dates for these domains, sheet first. */
export function fetchWarmupDates(
  params: { domains: string[]; url?: string; tab?: string },
  signal?: AbortSignal
) {
  return request<WarmupDatesResponse>("/api/start-outreach/warmup-dates", {
    method: "POST",
    body: params,
    signal,
  });
}

export function startStartOutreach(payload: StartOutreachStartPayload, signal?: AbortSignal) {
  return request<{ jobId: string }>("/api/jobs/start-outreach/start", { method: "POST", body: payload, signal });
}
export function listStartOutreachJobs(signal?: AbortSignal) {
  return request<{ jobs: StartOutreachJob[] }>("/api/jobs/start-outreach/list", { signal });
}
export function abortStartOutreachJob(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/start-outreach/abort", { method: "POST", body: { jobId }, signal });
}
export function deleteStartOutreachJob(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/start-outreach/delete", { method: "POST", body: { jobId }, signal });
}

// --- Copy Campaign to Other Workspace ---------------------------------------

export interface CopyCampaignPayload {
  sourceWorkspaceId: string;
  sourceCampaignId: string;
  destWorkspaceId: string;
  destCampaignId: string;
  name: string;
  duplicateSubsequences?: boolean;
}

export interface CopyCampaignResponse {
  createdId: string;
  name: string;
  stepsCopied: number;
  variationsCopied: number;
  droppedDeleted: number;
  subsequences: number;
  verified: boolean;
  problems: string[];
  warnings: string[];
}

export function runCopyCampaign(payload: CopyCampaignPayload, signal?: AbortSignal) {
  return request<CopyCampaignResponse>("/api/copy-campaign/run", {
    method: "POST",
    body: payload,
    signal,
  });
}

// --- Clone Campaign with Winning Variants -----------------------------------

export type { CloneResult, WinnersPreview } from "@/lib/winning-variants/plan";

/** A campaign's step-1 variants with their all-time figures, and its tags. Creates nothing. */
export function previewWinningVariants(params: { workspaceId: string; campaignId: string }, signal?: AbortSignal) {
  return request<import("@/lib/winning-variants/plan").WinnersPreview>("/api/winning-variants/preview", { method: "POST", body: params, signal });
}

export interface CloneWinnersPayload {
  workspaceId: string;
  campaignId: string;
  name: string;
  tagIds: string[];
  newTags: string[];
  /** Step 1 has no winners, and the page has said so. */
  confirmEmpty: boolean;
}

export function cloneWinningVariants(payload: CloneWinnersPayload, signal?: AbortSignal) {
  return request<import("@/lib/winning-variants/plan").CloneResult>("/api/winning-variants/run", { method: "POST", body: payload, signal });
}

// --- Change Limits with Best Performing Inboxes -----------------------------

export function startChangeLimits(payload: ChangeLimitsStartPayload, signal?: AbortSignal) {
  return request<{ jobId: string }>("/api/jobs/change-limits/start", { method: "POST", body: payload, signal });
}
export function listChangeLimitsJobs(signal?: AbortSignal) {
  return request<{ jobs: ChangeLimitsJob[] }>("/api/jobs/change-limits/list", { signal });
}
export function abortChangeLimitsJob(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/change-limits/abort", { method: "POST", body: { jobId }, signal });
}
export function deleteChangeLimitsJob(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/change-limits/delete", { method: "POST", body: { jobId }, signal });
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

export function deleteMoveLeadsJob(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/move-leads/delete", {
    method: "POST",
    body: { jobId },
    signal,
  });
}

export interface AzureWarmupSettingsResponse {
  settings: AzureWarmupSettings;
  /** 0 until someone has saved; the defaults are in use until then. */
  updatedAt: number;
  defaults: AzureWarmupSettings;
}

export function getAzureWarmupSettings(signal?: AbortSignal) {
  return request<AzureWarmupSettingsResponse>("/api/jobs/azure-warmup/settings", { signal });
}

export function saveAzureWarmupSettings(settings: AzureWarmupSettings) {
  return request<AzureWarmupSettingsResponse>("/api/jobs/azure-warmup/settings", { method: "PUT", body: settings });
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

export interface EmailStatsBulkParams {
  workspace_id: string;
  start_date: string;
  end_date: string;
  /** Comma-separated, at most 100. Omit for every mailbox in the workspace, paged. */
  email_acc_ids?: string;
  include_chart?: boolean;
  page?: number;
  limit?: number;
}

export interface EmailStatsBulkResponse {
  page?: number;
  limit?: number;
  total_accounts?: number;
  has_more?: boolean;
  accounts?: Array<Record<string, unknown>>;
}

/** Stats for every sending mailbox individually, 100 per call. */
export function fetchEmailStatsBulk(params: EmailStatsBulkParams, signal?: AbortSignal) {
  const qs = new URLSearchParams({
    workspace_id: params.workspace_id,
    start_date: params.start_date,
    end_date: params.end_date,
    include_chart: params.include_chart === false ? "false" : "true",
  });
  if (params.email_acc_ids) qs.set("email_acc_ids", params.email_acc_ids);
  if (params.page) qs.set("page", String(params.page));
  if (params.limit) qs.set("limit", String(params.limit));
  return request<EmailStatsBulkResponse>(`/api/plusvibe/email-stats-bulk?${qs.toString()}`, {
    signal,
  });
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

// --- Account delete + warmup settings --------------------------------------
//
// Thin wrappers over the generic Plusvibe proxies. The warmup fields are
// whitelisted server-side.

/** Warmup fields forwarded to PUT /account/bulk-update. */
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
}

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

/** Continues a run a restart cut off. Returns the new run's id. */
export function resumeCampaignTypes(jobId: string, signal?: AbortSignal) {
  return request<{ jobId: string }>("/api/jobs/campaign-types/resume", {
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

// --- Find Burned Domains & Inboxes ---------------------------------------------

export function fetchBurnedSettings(signal?: AbortSignal) {
  return request<{ settings: BurnedSettings }>("/api/jobs/burned/settings", { signal });
}

/** Only the providers given change; the other keeps what it had. */
export function saveBurnedSettings(
  patch: Partial<Record<Esp, { minSends: number; replyOooPct: number }>>,
  signal?: AbortSignal
) {
  return request<{ settings: BurnedSettings }>("/api/jobs/burned/settings", { method: "PUT", body: patch, signal });
}

export function startBurnedScan(payload: BurnedStartPayload, signal?: AbortSignal) {
  return request<{ jobId: string }>("/api/jobs/burned/start", { method: "POST", body: payload, signal });
}

export function listBurnedJobs(signal?: AbortSignal) {
  return request<{ jobs: BurnedJob[] }>("/api/jobs/burned/list", { signal });
}

export function abortBurnedJob(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/burned/abort", { method: "POST", body: { jobId }, signal });
}

export function deleteBurnedJob(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/burned/delete", { method: "POST", body: { jobId }, signal });
}

// --- Remove Inboxes & Domains -------------------------------------------------

export function startBurnedRemoval(payload: RemovalStartPayload, signal?: AbortSignal) {
  return request<{ jobId: string }>("/api/jobs/burned-removal/start", { method: "POST", body: payload, signal });
}

export function listBurnedRemovals(signal?: AbortSignal) {
  return request<{ jobs: BurnedRemovalJob[] }>("/api/jobs/burned-removal/list", { signal });
}

export function abortBurnedRemoval(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/burned-removal/abort", { method: "POST", body: { jobId }, signal });
}

// --- Sending Capacity ---------------------------------------------------------

export function startCapacityRefresh(signal?: AbortSignal) {
  return request<{ jobId: string }>("/api/jobs/capacity/start", { method: "POST", body: {}, signal });
}

export function listCapacityJobs(signal?: AbortSignal) {
  return request<{ jobs: CapacityJob[] }>("/api/jobs/capacity/list", { signal });
}

export function abortCapacityJob(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/capacity/abort", { method: "POST", body: { jobId }, signal });
}

export function deleteCapacityJob(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/capacity/delete", { method: "POST", body: { jobId }, signal });
}

// --- Start Outreach: saved settings and the week 2 switch ---------------------

export function fetchOutreachSettings(signal?: AbortSignal) {
  return request<{ settings: OutreachSettings }>("/api/jobs/start-outreach/settings", { signal });
}

export function saveOutreachSettings(settings: OutreachSettings, signal?: AbortSignal) {
  return request<{ settings: OutreachSettings }>("/api/jobs/start-outreach/settings", {
    method: "PUT",
    body: settings,
    signal,
  });
}

export function listOutreachSwitches(signal?: AbortSignal) {
  return request<{ switches: ScheduledSwitch[] }>("/api/jobs/start-outreach/scheduled", { signal });
}

export function cancelOutreachSwitch(id: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/outreach-switch/cancel", { method: "POST", body: { id }, signal });
}

export function deleteOutreachSwitch(id: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/outreach-switch/delete", { method: "POST", body: { id }, signal });
}

export function runOutreachSwitchNow(id: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/outreach-switch/run-now", { method: "POST", body: { id }, signal });
}

export function deleteBurnedRemoval(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/burned-removal/delete", { method: "POST", body: { jobId }, signal });
}

// --- Inbox Rotation -----------------------------------------------------------

export function fetchInboxRotationSettings(signal?: AbortSignal) {
  return request<{ settings: RotationSettings }>("/api/jobs/inbox-rotation/settings", { signal });
}

/** Replaces the profiles given; the rest are kept. Refused whole if any fails to validate. */
export function saveInboxRotationSettings(profiles: Partial<Record<ProfileKey, Profile>>, signal?: AbortSignal) {
  return request<{ settings: RotationSettings }>("/api/jobs/inbox-rotation/settings", {
    method: "PUT",
    body: { profiles },
    signal,
  });
}

export type RotationListItem = WorkspaceRotation & {
  running: boolean;
  positions: Partial<Record<ProfileKey, Position>>;
};

export function fetchInboxRotations(signal?: AbortSignal) {
  return request<{ rotations: RotationListItem[]; today: string; serverKey: boolean }>(
    "/api/jobs/inbox-rotation/rotations",
    { signal }
  );
}

/** Re-reads the workspace and writes today's settings now. */
export function applyInboxRotation(id: string, force = false, signal?: AbortSignal) {
  return request<{ ok: boolean; running: boolean }>("/api/jobs/inbox-rotation/apply", {
    method: "POST",
    body: { id, force },
    signal,
  });
}

export function setUpInboxRotation(input: SetupInput, signal?: AbortSignal) {
  return request<{ rotation: WorkspaceRotation }>("/api/jobs/inbox-rotation/rotations", {
    method: "POST",
    body: input,
    signal,
  });
}

export function removeInboxRotation(id: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/inbox-rotation/rotations", {
    method: "DELETE",
    body: { id },
    signal,
  });
}

/** One campaign's sending schedule as a week, for copying it onto others. */
export function fetchCampaignSchedule(
  params: { workspace_id: string; campaign_id: string },
  signal?: AbortSignal
) {
  const qs = new URLSearchParams(params);
  return request<{ week: WeekSchedule; exact: boolean }>(
    `/api/bulk-actions/campaign-schedule?${qs.toString()}`,
    { signal }
  );
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

export function setBlockedDomainSettings(
  patch: {
    autoDelete?: boolean;
    checkPerformance?: boolean;
    minReplyRateOoo?: number;
    minDomainReplyRateOoo?: number;
    recheck?: boolean;
    recheckDays?: number;
    inboxRules?: InboxRules;
    cancelAfterDeleted?: number;
    cancelKeepReplyRate?: number;
  },
  signal?: AbortSignal
) {
  // `rescheduled` counts the watched domains moved onto a new gap between
  // checks — only ever non-zero when recheckDays changed.
  return request<{ settings: BlockedDomainsView["settings"]; rescheduled?: number }>(
    "/api/jobs/blocked-domains/settings",
    { method: "PUT", body: patch, signal }
  );
}

export function setBlockedDomainAutoDelete(
  autoDelete: boolean,
  signal?: AbortSignal
) {
  return setBlockedDomainSettings({ autoDelete }, signal);
}

/** Runs the repeat assessment now, or arms/disarms it for one domain. */
export function recheckBlockedDomain(
  jobId: string,
  action: "now" | "on" | "off" = "now",
  signal?: AbortSignal
) {
  return request<{ ok: boolean }>("/api/jobs/blocked-domains/recheck", {
    method: "POST",
    body: { jobId, action },
    signal,
  });
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

/** Re-judge one domain on the wider window, or every record in the background. */
export function rejudgeBlockedDomain(target: { jobId: string } | { all: true }, signal?: AbortSignal) {
  return request<{ ok?: boolean; started?: boolean; total?: number }>(
    "/api/jobs/blocked-domains/rejudge",
    { method: "POST", body: target, signal }
  );
}

/** Turn the restorable inboxes back on at a daily limit. */
export function restoreBlockedDomainInboxes(jobId: string, dailyLimit: number, signal?: AbortSignal) {
  return request<{ ok: boolean; restored: number; error?: string }>(
    "/api/jobs/blocked-domains/restore",
    { method: "POST", body: { jobId, dailyLimit }, signal }
  );
}

/** Delete the inboxes the automation stopped on a domain not already waiting on a deletion. */
export function deleteStoppedBlockedDomainInboxes(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean; deleted: number; error?: string }>(
    "/api/jobs/blocked-domains/delete-stopped",
    { method: "POST", body: { jobId }, signal }
  );
}

/** List a Google domain's burned inboxes on the Google tab when the run did not. */
export function listBlockedDomainGoogleInboxes(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean; listed: number; already: number; error?: string }>(
    "/api/jobs/blocked-domains/list-google",
    { method: "POST", body: { jobId }, signal }
  );
}

/** Put a written-off domain's Status back and return it to kept. */
export function undoBlockedDomainWriteOff(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/blocked-domains/undo-write-off", {
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

export type BlockedInboxAction =
  | { action: "confirm" | "dismiss" | "remove"; jobId: string }
  | { action: "confirm-all" }
  | { action: "check"; email: string }
  | { action: "tenant-block"; domain: string }
  | { action: "hide-domain"; domain: string };

/** Acts on the inbox-level log: delete, keep, forget, delete all waiting, or check one inbox. */
export function blockedInboxAction(body: BlockedInboxAction) {
  return request<{ ok: boolean; deleting?: number; outcome?: string; jobId?: string; domain?: string }>("/api/jobs/blocked-inboxes/action", {
    method: "POST",
    body,
  });
}

export function deleteBlockedDomainJob(jobId: string, signal?: AbortSignal) {
  return request<{ ok: boolean }>("/api/jobs/blocked-domains/delete", {
    method: "POST",
    body: { jobId },
    signal,
  });
}

// --- General Settings --------------------------------------------------------

export interface GeneralSettingsResponse {
  settings: GeneralSettings;
  /** 0 when they have never been saved. */
  updatedAt: number;
}

export function fetchGeneralSettings(signal?: AbortSignal) {
  return request<GeneralSettingsResponse>("/api/general-settings", { signal });
}

export function saveGeneralSettings(settings: GeneralSettings, signal?: AbortSignal) {
  return request<GeneralSettingsResponse>("/api/general-settings", { method: "PUT", body: { settings }, signal });
}
