// The weekly Find Burned run, as the page shows it (server + client).

import type { Esp, ScheduleMode, ScheduleSettings } from "@/lib/burned/settings";

export interface WeeklyStep {
  esp: Esp;
  scanJobId?: string;
  /** How the scan finished. */
  scanStatus?: string;
  /** Rows the scan looked at, judged or not. */
  scanned?: number;
  /** Of those, the ones with a verdict: not too quiet, too new or without a baseline. */
  judged?: number;
  burned?: number;
  removalJobId?: string;
  removalStatus?: string;
  inboxesDeleted?: number;
  /** Why nothing was removed, when that is the outcome in remove mode. */
  note?: string;
}

export interface WeeklyRun {
  /** The Monday that names the week the run was for. */
  week: string;
  trigger: "scheduled" | "manual";
  mode: ScheduleMode;
  status: "running" | "done" | "error" | "interrupted";
  startedAt: number;
  finishedAt?: number;
  start: string;
  end: string;
  steps: WeeklyStep[];
  errors: string[];
}

export interface WeeklyState {
  /** The last week the scheduled run started for, so it never runs twice in one. */
  lastWeek?: string;
  lastRun?: WeeklyRun;
}

export interface WeeklyStatus {
  schedule: ScheduleSettings;
  state: WeeklyState;
  /** Epoch ms of the next scheduled run; null while the schedule is off. */
  nextRunAt: number | null;
  /** PLUSVIBE_API_KEY is set, so there is a key to run with. */
  serverKey: boolean;
  /** GOOGLE_SERVICE_ACCOUNT_JSON is set, so the remove mode can write the sheet. */
  sheetWriting: boolean;
  running: boolean;
}
