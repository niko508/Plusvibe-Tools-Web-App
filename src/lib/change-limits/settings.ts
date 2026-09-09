// The "Increase settings" half of Change Limits with Best Performing Inboxes:
// the five values the user sets, and what they become on the wire.
//
// Every field is optional. A blank field is left alone on the inbox rather
// than being sent as a zero — raising the daily limit without touching warmup
// has to be possible, and the only way to say "don't touch it" to a bulk
// update is to leave the key out entirely.
//
// Pure module — no API, no clock — so all of it is unit-tested.

/** The form's raw strings, exactly as typed. */
export interface SettingsInput {
  campaignEmails: string;
  warmupEmails: string;
  randomize: string;
  warmupReplyRate: string;
  intervalMinutes: string;
}

export const EMPTY_SETTINGS: SettingsInput = {
  campaignEmails: "",
  warmupEmails: "",
  randomize: "",
  warmupReplyRate: "",
  intervalMinutes: "",
};

export type SettingsKey = keyof SettingsInput;

export interface FieldSpec {
  key: SettingsKey;
  /** What the field is called in the tool. */
  label: string;
  /** The field it becomes on PUT /account/bulk-update. */
  apiField: string;
  unit: string;
  min: number;
  max: number;
  integer: boolean;
  hint: string;
}

/**
 * The five settings, in the order the user asked for them. `min`/`max` follow
 * Plusvibe's own bounds: daily_limit allows 0, the warmup limits start at 1,
 * the reply rate is a 0–1 fraction there and a percentage here.
 */
export const FIELDS: FieldSpec[] = [
  {
    key: "campaignEmails",
    label: "Campaign emails",
    apiField: "daily_limit",
    unit: "per day",
    min: 0,
    max: 2000,
    integer: true,
    hint: "Campaign emails the inbox may send per day.",
  },
  {
    key: "warmupEmails",
    label: "Warmup emails",
    apiField: "warmup_max_daily_limit",
    unit: "per day",
    min: 1,
    max: 1000,
    integer: true,
    hint: "Warmup emails per day at full pace.",
  },
  {
    key: "randomize",
    label: "Randomized Warm-Up Limit",
    apiField: "warmup_randomize_num",
    unit: "%",
    min: 0,
    max: 100,
    integer: true,
    hint: "Varies the warmup volume by this much either way. 0 switches randomising off.",
  },
  {
    key: "warmupReplyRate",
    label: "Warmup reply rate",
    apiField: "warmup_reply_rate",
    unit: "%",
    min: 0,
    max: 100,
    integer: false,
    hint: "Share of warmup emails that get replied to.",
  },
  {
    key: "intervalMinutes",
    label: "Email Interval",
    apiField: "interval_limit_in_min",
    unit: "minutes",
    min: 1,
    max: 1440,
    integer: true,
    hint: "Minimum wait between two emails from this inbox.",
  },
];

export const FIELD_BY_KEY: Record<SettingsKey, FieldSpec> = FIELDS.reduce(
  (acc, f) => {
    acc[f.key] = f;
    return acc;
  },
  {} as Record<SettingsKey, FieldSpec>
);

export interface SettingsRow {
  key: SettingsKey;
  label: string;
  apiField: string;
  /** Human-readable, e.g. "40 per day" or "46%". */
  value: string;
}

export interface ParsedSettings {
  /** Only the fields that were filled in, as numbers in the tool's units. */
  values: Partial<Record<SettingsKey, number>>;
  /** Field key → what is wrong with it. */
  problems: Partial<Record<SettingsKey, string>>;
  /** The body to merge into PUT /account/bulk-update. Empty if nothing is set. */
  body: Record<string, string | number>;
  /** One row per field that will be applied, for the preview and the job. */
  summary: SettingsRow[];
  /** How many fields will be applied. */
  count: number;
  ok: boolean;
}

const isBlank = (v: string) => v.trim() === "";

/**
 * Reads the form. Blank fields are skipped; anything filled in has to be a
 * number inside the field's range, and says so by name when it isn't.
 */
export function parseSettings(input: SettingsInput): ParsedSettings {
  const values: Partial<Record<SettingsKey, number>> = {};
  const problems: Partial<Record<SettingsKey, string>> = {};
  const body: Record<string, string | number> = {};
  const summary: SettingsRow[] = [];

  for (const f of FIELDS) {
    const raw = input[f.key] ?? "";
    if (isBlank(raw)) continue;
    const n = Number(raw.trim());
    if (!Number.isFinite(n)) {
      problems[f.key] = `${f.label} must be a number.`;
      continue;
    }
    if (f.integer && !Number.isInteger(n)) {
      problems[f.key] = `${f.label} must be a whole number.`;
      continue;
    }
    if (n < f.min || n > f.max) {
      problems[f.key] = `${f.label} must be between ${f.min} and ${f.max} ${f.unit}.`;
      continue;
    }
    values[f.key] = n;
  }

  if (values.campaignEmails !== undefined) {
    body.daily_limit = values.campaignEmails;
    summary.push(row("campaignEmails", `${values.campaignEmails} per day`));
  }
  if (values.warmupEmails !== undefined) {
    body.warmup_max_daily_limit = values.warmupEmails;
    summary.push(row("warmupEmails", `${values.warmupEmails} per day`));
  }
  if (values.randomize !== undefined) {
    // Plusvibe's randomize number starts at 1, so 0 is said as "off" with the
    // switch rather than as a zero it would refuse.
    if (values.randomize === 0) {
      body.warmup_randomize = "no";
      summary.push(row("randomize", "Off"));
    } else {
      body.warmup_randomize = "yes";
      body.warmup_randomize_num = values.randomize;
      summary.push(row("randomize", `${values.randomize}%`));
    }
  }
  if (values.warmupReplyRate !== undefined) {
    // The API takes a 0–1 fraction; the tool asks for a percentage.
    body.warmup_reply_rate = Math.round((values.warmupReplyRate / 100) * 1000) / 1000;
    summary.push(row("warmupReplyRate", `${values.warmupReplyRate}%`));
  }
  if (values.intervalMinutes !== undefined) {
    body.interval_limit_in_min = values.intervalMinutes;
    summary.push(
      row("intervalMinutes", `${values.intervalMinutes} minute${values.intervalMinutes === 1 ? "" : "s"}`)
    );
  }

  const problemCount = Object.keys(problems).length;
  return {
    values,
    problems,
    body,
    summary,
    count: summary.length,
    ok: problemCount === 0 && summary.length > 0,
  };
}

function row(key: SettingsKey, value: string): SettingsRow {
  const f = FIELD_BY_KEY[key];
  return { key, label: f.label, apiField: f.apiField, value };
}

/** A one-line description of the settings, for a job label. */
export function describeSettings(rows: SettingsRow[]): string {
  if (rows.length === 0) return "no settings";
  return rows.map((r) => `${r.label} ${r.value}`).join(" · ");
}
