"use client";

import { getApiKey } from "@/lib/api-key";
import type {
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
  init?: { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal }
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
