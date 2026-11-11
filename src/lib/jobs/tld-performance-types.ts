// TLD Performance Tracking reports, as the page sees them (server + client).

import type { ReportBody, Rules } from "@/lib/tld-performance/report";
import type { TldSettings } from "@/lib/tld-performance/schedule";

export interface TldReport {
  id: string;
  /** "2026-10" */
  month: string;
  start: string;
  end: string;
  trigger: "manual" | "scheduled";
  status: "running" | "done" | "error" | "interrupted";
  phase: "registrars" | "inboxes" | "blocks" | "sheet" | "finished";
  createdAt: number;
  finishedAt?: number;
  progress: { workspacesDone: number; workspacesTotal: number; inboxes: number };
  /** The rules the ratings were made with. */
  rules: Rules;
  /** The tables. Absent while running, and on a run that failed early. */
  body?: ReportBody;
  /** How the write to the sheet went, when a sheet is set. */
  sheet?: { ok: boolean; spreadsheetId?: string; tab?: string; at?: number; error?: string };
  errors: string[];
}

/** A report without its tables: what the list shows. */
export type TldReportSummary = Omit<TldReport, "body">;

export interface TldStatus {
  settings: TldSettings;
  reports: TldReportSummary[];
  /** The id of the report being made, if any. */
  running: string | null;
  nextRunAt: number | null;
  serverKey: boolean;
  sheetWriting: boolean;
  /** The month a run made now would cover by default. */
  lastFullMonth: string;
}
