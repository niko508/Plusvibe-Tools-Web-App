import type { InboxRates } from "@/lib/inbox-performance/metrics";
import type { ProviderBucket, Verdict } from "@/lib/change-limits/qualify";

/** The three menu items across the top of the tool. */
export type Tab = "inboxes" | "settings" | "runs";

export const TABS: { key: Tab; label: string }[] = [
  { key: "inboxes", label: "Find inboxes" },
  { key: "settings", label: "Increase settings" },
  { key: "runs", label: "Runs" },
];

export type RowStatus = "pending" | "loading" | "done" | "error";

export interface InboxRow {
  id: string;
  email: string;
  workspaceId: string;
  workspaceName: string;
  /** Plusvibe's own key, e.g. GOOGLE_WORKSPACE — what the badge shows. */
  provider: string;
  /** The same thing bucketed, which is what the thresholds are keyed on. */
  bucket: ProviderBucket;
  accountStatus?: string;
  status: RowStatus;
  rates?: InboxRates;
  error?: string;
  /** Set once thresholds have been applied to the loaded figures. */
  verdict?: Verdict;
  /** The rate this inbox was measured against. */
  threshold?: number | null;
}

export type SortKey =
  | "inbox"
  | "workspace"
  | "provider"
  | "sent"
  | "contacted"
  | "replies"
  | "reply_rate"
  | "verdict";

export interface SortState {
  key: SortKey;
  dir: "asc" | "desc";
}
