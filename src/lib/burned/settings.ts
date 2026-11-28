// What counts as burned, per ESP.
//
// A row (an inbox for Google, a domain for Microsoft) is judged against the
// REST OF ITS OWN WORKSPACE on the same provider, never against one fixed bar
// for everyone. Which client a domain sends for decides most of its reply
// rate, so a fixed bar burns every domain of a client whose leads reply less
// and misses weak domains of a client whose leads reply more.
//
// Three numbers decide it, kept PER PROVIDER:
//
//   Minimum sends     below this there is nothing to judge — at these reply
//                     rates a few hundred sends brings only a handful of
//                     replies, and zero of them is often just luck
//   Minimum days      days since the row's first send in the window. A new
//                     domain's latest emails have not had time to be answered
//                     yet, so its first weeks always read low
//   % of workspace    burned when the reply rate (OOO included) is under this
//                     share of the rest of the workspace's, on the same
//                     provider, AND the real reply rate is under the same
//                     share of the workspace's real rate. Something people
//                     are actually answering is not burned, however few
//                     auto-replies come back with it
//
// Each provider's set is saved and comes back as what the form starts on,
// until it is edited again.
//
// Pure module — the file on disk is store.ts — so all of it is unit-tested
// and the form can import it.

export type Esp = "google" | "microsoft";

export const ESPS: Esp[] = ["google", "microsoft"];

export const ESP_LABELS: Record<Esp, string> = {
  google: "Google",
  microsoft: "Microsoft",
};

/**
 * What a run looks at for each provider.
 *
 * Google is judged INBOX by inbox: Google mailboxes burn one at a time, and a
 * domain's average hides the ones that have. Microsoft is judged by DOMAIN,
 * the way this tool always has — a Microsoft tenant's mailboxes go together.
 */
export type Level = "inbox" | "domain";

export const LEVEL_OF: Record<Esp, Level> = {
  google: "inbox",
  microsoft: "domain",
};

export function levelOf(esp: Esp): Level {
  return LEVEL_OF[esp];
}

/** What a row IS, for the labels: "inbox"/"inboxes" or "domain"/"domains". */
export const NOUNS: Record<Level, { one: string; many: string }> = {
  inbox: { one: "inbox", many: "inboxes" },
  domain: { one: "domain", many: "domains" },
};

/** "1 inbox", "11 inboxes" — an -s plural would say "inboxs". */
export function countNoun(n: number, esp: Esp): string {
  const noun = NOUNS[levelOf(esp)];
  return `${n.toLocaleString()} ${n === 1 ? noun.one : noun.many}`;
}

export function isEsp(v: unknown): v is Esp {
  return v === "google" || v === "microsoft";
}

export interface Thresholds {
  /** Emails sent in the window, below which the row is not judged. */
  minSends: number;
  /** Days from the row's first send in the window to its end, below which it is not judged. */
  minDays: number;
  /**
   * Burned when both reply rates are under this percentage of the rest of the
   * workspace's on the same provider: 50 means "under half".
   */
  relativePct: number;
  /**
   * Days of figures the weekly run reads for this provider, ending yesterday.
   * Google inboxes send about 175 a month and get about 3 replies, OOO
   * included — too few to judge on 30 days — so Google reads 60.
   */
  windowDays: number;
  /**
   * Burned outright, whatever the workspace does: this many sends or more and
   * not one reply, OOO included, once past the minimum days. 0 switches the
   * rule off.
   */
  zeroReplySends: number;
}

/**
 * Google mailboxes send 20 to 30 a day, so 300 sends is two to three weeks of
 * one inbox; a Microsoft domain sends across many mailboxes, so it is held to
 * 750. Both need two weeks of outreach behind them, and both are burned at
 * under half the rest of their workspace.
 */
export const DEFAULT_THRESHOLDS: Record<Esp, Thresholds> = {
  google: { minSends: 250, minDays: 14, relativePct: 50, windowDays: 60, zeroReplySends: 150 },
  microsoft: { minSends: 750, minDays: 14, relativePct: 50, windowDays: 30, zeroReplySends: 0 },
};

/**
 * The weekly run. Monday morning, Helsinki time, over the last 30 days.
 *
 *   report  scans both providers and keeps the results here, nothing else
 *   remove  also records the burned rows in the sheet and deletes their
 *           inboxes, the same as pressing Remove on the scan
 */
export type ScheduleMode = "report" | "remove";

export interface ScheduleSettings {
  enabled: boolean;
  mode: ScheduleMode;
  /** The Email Infrastructure sheet the remove mode writes; blank uses SPREADSHEET_ID. */
  sheetUrl: string;
}

export const DEFAULT_SCHEDULE: ScheduleSettings = { enabled: false, mode: "report", sheetUrl: "" };

export interface BurnedSettings {
  thresholds: Record<Esp, Thresholds>;
  schedule: ScheduleSettings;
  updatedAt: number;
}

export const DEFAULT_SETTINGS: BurnedSettings = {
  thresholds: { google: { ...DEFAULT_THRESHOLDS.google }, microsoft: { ...DEFAULT_THRESHOLDS.microsoft } },
  schedule: { ...DEFAULT_SCHEDULE },
  updatedAt: 0,
};

export const MAX_MIN_SENDS = 1_000_000;

/** A whole number of sends, 0 up. Returns the problem, in words, when it isn't. */
export function parseMinSends(raw: unknown): { value: number | null; error?: string } {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
    return { value: null, error: "Minimum sends: enter a number." };
  }
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return { value: null, error: "Minimum sends: enter a number." };
  if (!Number.isInteger(n)) return { value: null, error: "Minimum sends: use a whole number." };
  if (n < 0) return { value: null, error: "Minimum sends: can't be negative." };
  if (n > MAX_MIN_SENDS) return { value: null, error: `Minimum sends: ${MAX_MIN_SENDS.toLocaleString()} is the most.` };
  return { value: n };
}

/** A percentage from 0 to 100, fractions allowed. The label names it in the problem. */
export function parsePercent(raw: unknown, label: string): { value: number | null; error?: string } {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
    return { value: null, error: `${label}: enter a percentage.` };
  }
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return { value: null, error: `${label}: enter a percentage.` };
  if (n < 0) return { value: null, error: `${label}: can't be negative.` };
  if (n > 100) return { value: null, error: `${label}: must be 100 or less.` };
  return { value: Math.round(n * 100) / 100 };
}

export const MAX_MIN_DAYS = 90;

/** Whole days, 0 to 90: the bulk stats endpoint reads no further back. */
export function parseMinDays(raw: unknown): { value: number | null; error?: string } {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
    return { value: null, error: "Minimum days: enter a number." };
  }
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return { value: null, error: "Minimum days: enter a number." };
  if (!Number.isInteger(n)) return { value: null, error: "Minimum days: use a whole number." };
  if (n < 0) return { value: null, error: "Minimum days: can't be negative." };
  if (n > MAX_MIN_DAYS) return { value: null, error: `Minimum days: ${MAX_MIN_DAYS} is the most.` };
  return { value: n };
}

/** The share of the workspace's rate, 1 to 100. 0 would burn nothing, so it is refused. */
export function parseRelativePct(raw: unknown): { value: number | null; error?: string } {
  const p = parsePercent(raw, "% of workspace");
  if (p.error) return p;
  if ((p.value as number) <= 0) return { value: null, error: "% of workspace: must be more than 0." };
  return p;
}

export const MIN_WINDOW_DAYS = 7;
export const MAX_WINDOW_DAYS = 90;

/** Whole days, 7 to 90: the weekly run's window. */
export function parseWindowDays(raw: unknown): { value: number | null; error?: string } {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
    return { value: null, error: "Weekly window: enter a number of days." };
  }
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n)) return { value: null, error: "Weekly window: use a whole number of days." };
  if (n < MIN_WINDOW_DAYS || n > MAX_WINDOW_DAYS) {
    return { value: null, error: `Weekly window: ${MIN_WINDOW_DAYS} to ${MAX_WINDOW_DAYS} days.` };
  }
  return { value: n };
}

/** Sends for the zero-replies rule: a whole number, 0 for off. */
export function parseZeroReplySends(raw: unknown): { value: number | null; error?: string } {
  const r = parseMinSends(raw);
  return r.error ? { value: null, error: r.error.replace("Minimum sends", "Zero replies after") } : r;
}

/** Problems with one provider's numbers, in reading order. Empty when they can be saved. */
export function validateThresholds(raw: {
  minSends?: unknown;
  minDays?: unknown;
  relativePct?: unknown;
  windowDays?: unknown;
  zeroReplySends?: unknown;
}): string[] {
  const problems: string[] = [];
  const checks = [parseMinSends(raw.minSends), parseMinDays(raw.minDays), parseRelativePct(raw.relativePct)];
  // The two newer numbers are optional in a save: left out, they keep what they had.
  if (raw.windowDays !== undefined) checks.push(parseWindowDays(raw.windowDays));
  if (raw.zeroReplySends !== undefined) checks.push(parseZeroReplySends(raw.zeroReplySends));
  for (const r of checks) if (r.error) problems.push(r.error);
  return problems;
}

/**
 * Whatever was given, as thresholds; anything unreadable falls back to the
 * default. A record from the old fixed-bar rule has none of the new numbers
 * except the minimum sends, and reads as that provider's defaults.
 */
export function normalizeThresholds(raw: unknown, esp: Esp): Thresholds {
  const r = (raw ?? {}) as { minSends?: unknown; minDays?: unknown; relativePct?: unknown; windowDays?: unknown; zeroReplySends?: unknown };
  const legacy = r.relativePct === undefined;
  const sends = parseMinSends(r.minSends);
  const days = parseMinDays(r.minDays);
  const rel = parseRelativePct(r.relativePct);
  const win = parseWindowDays(r.windowDays);
  const zero = parseZeroReplySends(r.zeroReplySends);
  const d = DEFAULT_THRESHOLDS[esp];
  return {
    minSends: legacy ? d.minSends : sends.value ?? d.minSends,
    minDays: days.value ?? d.minDays,
    relativePct: rel.value ?? d.relativePct,
    windowDays: win.value ?? d.windowDays,
    zeroReplySends: r.zeroReplySends === undefined ? d.zeroReplySends : zero.value ?? d.zeroReplySends,
  };
}

export function isScheduleMode(v: unknown): v is ScheduleMode {
  return v === "report" || v === "remove";
}

export function normalizeSchedule(raw: unknown): ScheduleSettings {
  const r = (raw ?? {}) as { enabled?: unknown; mode?: unknown; sheetUrl?: unknown };
  return {
    enabled: r.enabled === true,
    mode: isScheduleMode(r.mode) ? r.mode : DEFAULT_SCHEDULE.mode,
    sheetUrl: typeof r.sheetUrl === "string" ? r.sheetUrl.trim() : "",
  };
}

/** Whatever was stored, as settings: a bad or missing part reads as the default. */
export function normalizeSettings(raw: Partial<BurnedSettings> | null | undefined): BurnedSettings {
  const r = raw ?? {};
  const stored = (r.thresholds ?? {}) as Record<string, unknown>;
  return {
    thresholds: {
      google: normalizeThresholds(stored.google, "google"),
      microsoft: normalizeThresholds(stored.microsoft, "microsoft"),
    },
    schedule: normalizeSchedule(r.schedule),
    updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
  };
}

/** "Google inboxes · under 50% of their workspace's reply rate, on 300+ sends and 14+ days" */
export function describeThresholds(esp: Esp, t: Thresholds): string {
  const what = levelOf(esp) === "inbox" ? "inboxes" : "domains";
  const zero = t.zeroReplySends > 0 ? `, or no replies at all on ${t.zeroReplySends.toLocaleString()}+ sends` : "";
  return `${ESP_LABELS[esp]} ${what} · under ${t.relativePct}% of their workspace's reply rate, on ${t.minSends.toLocaleString()}+ sends and ${t.minDays}+ days${zero}`;
}
