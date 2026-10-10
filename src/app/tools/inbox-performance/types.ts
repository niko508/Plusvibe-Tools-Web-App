import type { EmailStatsChartPoint, EmailStatsHeader } from "@/lib/plusvibe-types";
import type { InboxRates } from "@/lib/inbox-performance/metrics";

export type RowStatus = "pending" | "loading" | "done" | "error";

/** The scope value that means every workspace. */
export const ALL_WORKSPACES = "__all__";

export interface InboxRow {
  id: string;
  email: string;
  domain: string;
  workspaceId: string;
  workspaceName: string;
  /** Sender ESP bucket: GOOGLE_WORKSPACE, MICROSOFT365 or REGULAR_ACCOUNT. */
  provider: string;
  accountStatus?: string;
  warmupStatus?: string;
  status: RowStatus;
  header?: EmailStatsHeader;
  chart?: EmailStatsChartPoint[];
  /** Computed over unique contacts once the header is in. */
  rates?: InboxRates;
  error?: string;
}

export type SortKey =
  | "inbox"
  | "workspace"
  | "provider"
  | "sent"
  | "contacted"
  | "replies"
  | "reply_rate"
  | "reply_rate_ooo"
  | "pos_reply_rate"
  | "bounce_rate";

export interface SortState {
  key: SortKey;
  dir: "asc" | "desc";
}
