import type {
  EmailStatsHeader,
  EmailStatsChartPoint,
} from "@/lib/plusvibe-types";

export type RowStatus = "pending" | "loading" | "done" | "error";

export interface DomainRow {
  domain: string;
  mailboxes: number;
  status: RowStatus;
  providers: string[]; // sender ESPs among this domain's mailboxes
  header?: EmailStatsHeader;
  chart?: EmailStatsChartPoint[];
  error?: string;
}

export type SortKey =
  | "domain"
  | "mailboxes"
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
