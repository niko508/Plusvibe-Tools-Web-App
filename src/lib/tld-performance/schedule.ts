// When the monthly TLD Performance report runs, and which month it covers.
//
// The 1st of each month at 06:00 Helsinki, for the month before. Replies to
// the month's last few days are still coming in then, so every combo reads a
// touch low — equally, so the comparison between combos holds.
//
// Pure module — the clock is always passed in — so all of it is unit-tested.

import { DEFAULT_RULES, type Rules } from "./report";
import { SWITCH_TIMEZONE, dateIn, instantAt } from "@/lib/start-outreach/schedule";

export const RUN_TIMEZONE = SWITCH_TIMEZONE;
export const RUN_DAY = 1;
export const RUN_HOUR = 6;

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-11" for the month `at` falls in, Helsinki time. */
export function monthOf(at: number, tz: string = RUN_TIMEZONE): string {
  return dateIn(at, tz).slice(0, 7);
}

/** The month before "2026-11": "2026-10". January goes back a year. */
export function previousMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
}

/** First and last day of a month, as YYYY-MM-DD. */
export function monthRange(month: string): { start: string; end: string } {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${pad(last)}` };
}

export function isMonth(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}$/.test(v)) return false;
  const m = Number(v.slice(5));
  return m >= 1 && m <= 12;
}

/** The last month that has fully ended, as of `at`. */
export function lastFullMonth(at: number, tz: string = RUN_TIMEZONE): string {
  return previousMonth(monthOf(at, tz));
}

/** This month's run time: the 1st at 06:00 Helsinki. */
export function dueThisMonth(at: number, tz: string = RUN_TIMEZONE): number {
  return instantAt(`${monthOf(at, tz)}-${pad(RUN_DAY)}`, RUN_HOUR, tz);
}

/** Due: past this month's time, and last month's report not made by the schedule yet. */
export function isDue(now: number, lastMonth: string | undefined, tz: string = RUN_TIMEZONE): boolean {
  return now >= dueThisMonth(now, tz) && lastMonth !== lastFullMonth(now, tz);
}

/** When the next scheduled run is. `now` itself when one is due. */
export function nextRunAt(now: number, lastMonth: string | undefined, tz: string = RUN_TIMEZONE): number {
  const due = dueThisMonth(now, tz);
  if (now < due) return due;
  if (lastMonth !== lastFullMonth(now, tz)) return now;
  const [y, m] = monthOf(now, tz).split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
  return instantAt(`${next}-${pad(RUN_DAY)}`, RUN_HOUR, tz);
}

// --- Settings ----------------------------------------------------------------

export interface TldSettings {
  /** The monthly run on the 1st. */
  enabled: boolean;
  /** Where the monthly report is written; blank writes nowhere. */
  sheetUrl: string;
  /** The tab it is written to, created if missing and rewritten each month. */
  sheetTab: string;
  rules: Rules;
  updatedAt: number;
}

export const DEFAULT_TAB = "TLD Performance";

export const DEFAULT_TLD_SETTINGS: TldSettings = {
  enabled: true,
  sheetUrl: "",
  sheetTab: DEFAULT_TAB,
  rules: { ...DEFAULT_RULES, hiddenPlatforms: [...DEFAULT_RULES.hiddenPlatforms] },
  updatedAt: 0,
};

function whole(v: unknown, min: number, max: number): number | null {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

export function normalizeTldSettings(raw: unknown): TldSettings {
  const r = (raw ?? {}) as Partial<TldSettings> & { rules?: Partial<Rules> };
  const rules: { minDomains?: unknown; minClients?: unknown; hiddenPlatforms?: unknown } = r.rules ?? {};
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : DEFAULT_TLD_SETTINGS.enabled,
    sheetUrl: typeof r.sheetUrl === "string" ? r.sheetUrl.trim() : "",
    sheetTab: typeof r.sheetTab === "string" && r.sheetTab.trim() ? r.sheetTab.trim() : DEFAULT_TAB,
    rules: {
      minDomains: whole(rules.minDomains, 1, 1000) ?? DEFAULT_RULES.minDomains,
      minClients: whole(rules.minClients, 1, 100) ?? DEFAULT_RULES.minClients,
      hiddenPlatforms: Array.isArray(rules.hiddenPlatforms)
        ? [...new Set((rules.hiddenPlatforms as unknown[]).map((p) => String(p).trim()).filter(Boolean))]
        : [...DEFAULT_RULES.hiddenPlatforms],
    },
    updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
  };
}

/** Problems with a settings patch, in words. Empty when it can be saved. */
export function validateTldPatch(raw: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") problems.push("Monthly run: on or off.");
  if (raw.sheetUrl !== undefined && typeof raw.sheetUrl !== "string") problems.push("Sheet: paste its link.");
  if (raw.sheetTab !== undefined && (typeof raw.sheetTab !== "string" || raw.sheetTab.length > 90)) problems.push("Tab: a name under 90 characters.");
  const rules = raw.rules as Record<string, unknown> | undefined;
  if (rules !== undefined) {
    if (!rules || typeof rules !== "object") problems.push("Rules: send them as an object.");
    else {
      if (rules.minDomains !== undefined && whole(rules.minDomains, 1, 1000) === null) problems.push("Minimum domains: a whole number from 1 to 1,000.");
      if (rules.minClients !== undefined && whole(rules.minClients, 1, 100) === null) problems.push("Minimum clients: a whole number from 1 to 100.");
      if (rules.hiddenPlatforms !== undefined && !Array.isArray(rules.hiddenPlatforms)) problems.push("Registrars not bought from: a list.");
    }
  }
  return problems;
}
