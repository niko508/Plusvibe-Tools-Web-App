"use client";

import { getApiKey } from "@/lib/api-key";
import type {
  EmailAccountsResponse,
  EmailStatsResponse,
  WorkspacesResponse,
} from "@/lib/plusvibe-types";

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

async function request<T>(url: string, signal?: AbortSignal): Promise<T> {
  const key = getApiKey();
  const res = await fetch(url, {
    headers: key ? { [KEY_HEADER]: key } : {},
    signal,
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
  return request<WorkspacesResponse>("/api/plusvibe/workspaces", signal);
}

export function fetchAccounts(
  params: { workspace_id: string; tags?: string },
  signal?: AbortSignal
) {
  const qs = new URLSearchParams({ workspace_id: params.workspace_id });
  if (params.tags) qs.set("tags", params.tags);
  return request<EmailAccountsResponse>(
    `/api/plusvibe/accounts?${qs.toString()}`,
    signal
  );
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
    signal
  );
}
