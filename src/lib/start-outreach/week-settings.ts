// The saved Start Outreach settings: two weeks of numbers for each kind of
// infrastructure.
//
// A new batch always starts on its category's WEEK 1 numbers, and a scheduled
// switch moves it onto WEEK 2 seven days later — the ramp that would otherwise
// be done by hand, on a morning somebody has to remember.
//
// The fields are the ones the run already applies (OUTREACH_FIELDS), so a week
// is just another set of those values and the same parser validates it. A
// blank field means "leave that setting as it is", exactly as it does today,
// which is how a week can change only the daily limit and touch nothing else.
//
// Pure module — the file on disk is store.ts — so all of it is unit-tested and
// the form imports it directly.

import { CATEGORIES, CATEGORY_LABELS, isCategory, type Category } from "./categories";
import {
  EMPTY_OUTREACH_SETTINGS,
  OUTREACH_FIELDS,
  parseOutreachSettings,
  type OutreachSettingsInput,
} from "./plan";

export type Week = 1 | 2;
export const WEEKS: Week[] = [1, 2];
export const WEEK_LABELS: Record<Week, string> = { 1: "Week 1", 2: "Week 2" };

/** How long a batch stays on its week 1 numbers. */
export const WEEK_LENGTH_DAYS = 7;

export interface CategorySettings {
  week1: OutreachSettingsInput;
  week2: OutreachSettingsInput;
}

export type OutreachSettings = Record<Category, CategorySettings>;

const settings = (week1: Partial<OutreachSettingsInput>, week2: Partial<OutreachSettingsInput>): CategorySettings => ({
  week1: { ...EMPTY_OUTREACH_SETTINGS, ...week1 },
  week2: { ...EMPTY_OUTREACH_SETTINGS, ...week2 },
});

/**
 * Starting numbers, for a form that has never been saved.
 *
 * Deliberately modest and clearly a starting point: week 2 opens the campaign
 * limit up and eases the warmup down, which is the shape of every ramp this
 * tool is used for. They are placeholders to edit, not advice.
 */
export const DEFAULT_OUTREACH_SETTINGS: OutreachSettings = {
  google: settings(
    { warmupEmails: "27", campaignEmails: "3", randomize: "10", warmupReplyRate: "35", intervalMinutes: "60" },
    { warmupEmails: "24", campaignEmails: "6", randomize: "10", warmupReplyRate: "35", intervalMinutes: "60" }
  ),
  azure25: settings(
    { warmupEmails: "27", campaignEmails: "3", randomize: "10", warmupReplyRate: "35", intervalMinutes: "60" },
    { warmupEmails: "24", campaignEmails: "6", randomize: "10", warmupReplyRate: "35", intervalMinutes: "60" }
  ),
  azure50: settings(
    { warmupEmails: "27", campaignEmails: "3", randomize: "10", warmupReplyRate: "35", intervalMinutes: "60" },
    { warmupEmails: "24", campaignEmails: "6", randomize: "10", warmupReplyRate: "35", intervalMinutes: "60" }
  ),
};

/** Only the five known fields, as strings, with anything else dropped. */
function normalizeWeek(raw: unknown): OutreachSettingsInput {
  const out = { ...EMPTY_OUTREACH_SETTINGS };
  if (!raw || typeof raw !== "object") return out;
  const given = raw as Record<string, unknown>;
  for (const f of OUTREACH_FIELDS) {
    const v = given[f.key];
    if (v === undefined || v === null) continue;
    out[f.key] = String(v).trim();
  }
  return out;
}

/**
 * Whatever came off disk or the wire, as a full set.
 *
 * A category or a week that isn't there falls back to the defaults, so a file
 * written before a category existed still reads rather than blanking the form.
 */
export function normalizeSettings(raw: unknown): OutreachSettings {
  const given = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out = {} as OutreachSettings;
  for (const c of CATEGORIES) {
    const cat = (given[c] && typeof given[c] === "object" ? given[c] : {}) as Record<string, unknown>;
    out[c] = {
      week1: cat.week1 === undefined ? { ...DEFAULT_OUTREACH_SETTINGS[c].week1 } : normalizeWeek(cat.week1),
      week2: cat.week2 === undefined ? { ...DEFAULT_OUTREACH_SETTINGS[c].week2 } : normalizeWeek(cat.week2),
    };
  }
  return out;
}

/**
 * Every problem in a whole set, named by category and week.
 *
 * The same rules as the run itself, because the run uses the same parser —
 * a number that would be refused when it is applied is refused when it is
 * saved, rather than a week later at six in the morning.
 */
export function validateSettings(s: OutreachSettings): string[] {
  const problems: string[] = [];
  for (const c of CATEGORIES) {
    for (const w of WEEKS) {
      const parsed = parseOutreachSettings(s[c][w === 1 ? "week1" : "week2"]);
      for (const p of Object.values(parsed.problems)) {
        if (p) problems.push(`${CATEGORY_LABELS[c]} — ${WEEK_LABELS[w]}: ${p}`);
      }
    }
  }
  return problems;
}

export function weekOf(s: CategorySettings, week: Week): OutreachSettingsInput {
  return week === 1 ? s.week1 : s.week2;
}

/** Whether a week would change anything at all — all blank changes nothing. */
export function weekIsEmpty(input: OutreachSettingsInput): boolean {
  return OUTREACH_FIELDS.every((f) => String(input[f.key] ?? "").trim() === "");
}

/**
 * Categories whose week 2 would do nothing.
 *
 * Worth saying out loud before a switch is scheduled: an all-blank week 2 is
 * a scheduled task that wakes up and leaves everything as it was.
 */
export function emptyWeek2(s: OutreachSettings, categories: Category[]): Category[] {
  return categories.filter((c) => weekIsEmpty(s[c].week2));
}

/** "Warmup emails 27 per day · Campaign emails 3 per day" for one week. */
export function describeWeek(input: OutreachSettingsInput): string {
  const rows = parseOutreachSettings(input).summary.filter((r) => !r.key.endsWith("RampUp"));
  return rows.length === 0 ? "nothing — every field is blank" : rows.map((r) => `${r.label} ${r.value}`).join(" · ");
}

export { isCategory };
