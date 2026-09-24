// The warmup settings Azure Start Warmup applies to every inbox it starts.
//
// They used to be fixed in code. Now they are set on the tool's Settings tab
// and stored on the server, and each run takes a copy when it starts: a run
// lasts up to 7 days, starting inboxes as they appear, and every inbox of one
// batch should warm the same way even if the settings change half-way.
//
// The defaults are the values that were fixed in code, so nothing changes
// until someone changes it.
//
// Pure module — no API, no disk — so all of it is unit-tested.

export const WEEK_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
export type WeekDay = (typeof WEEK_DAYS)[number];
export const WEEKDAYS: WeekDay[] = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

/** Plusvibe's Business Type choices, as its API lists them. */
export const BUSINESS_TYPES = [
  "Artificial Intelligence and Machine Learning",
  "Consulting Firms",
  "Cryptocurrency and Blockchain",
  "Digital Marketing Agencies",
  "E-commerce Businesses",
  "Education and Training Services",
  "Financial Services",
  "Healthcare and Wellness Providers",
  "Hospitality Services",
  "Human Resources and Recruiting",
  "Legal Services",
  "Manufacturing Companies",
  "Non-profit Organizations",
  "Pharmaceuticals and Biotech",
  "Real Estate Agencies",
  "Software and Technology Companies",
  "Transportation and Logistics",
] as const;

export interface WarmupSettings {
  /** Warmup emails a day to start from. */
  initialDailyLimit: number;
  /** Added each day until the maximum is reached. */
  paceIncrement: number;
  /** The most warmup emails a day. */
  maxDailyLimit: number;
  /** Ramp up gradually rather than starting at the maximum. */
  slowRampup: boolean;
  /** Randomized Warm-Up Limit: vary the daily limit so it looks natural. */
  randomize: boolean;
  /** Range in %: 20 means the day's limit falls between 80% and 100% of the maximum. */
  randomizeNum: number;
  /** One of BUSINESS_TYPES, or "" for Plusvibe's Generic Business Type (not sent). */
  businessType: string;
  /** Share of warmup emails that get a reply, in percent. */
  replyRatePct: number;
  /** IANA time zone the window is read in, e.g. "Asia/Singapore". */
  timezone: string;
  /** "HH:MM", 24-hour. */
  fromTime: string;
  toTime: string;
  days: WeekDay[];
  /**
   * The inbox's email signature. {{sender_first_name}} and
   * {{sender_last_name}} are filled per inbox by Plusvibe. Empty leaves each
   * inbox's own signature alone.
   */
  signature: string;
  /** Include the signature in warmup emails. */
  warmupSignature: boolean;
}

export const DEFAULT_WARMUP_SETTINGS: WarmupSettings = {
  initialDailyLimit: 2,
  paceIncrement: 3,
  maxDailyLimit: 18,
  slowRampup: true,
  randomize: true,
  randomizeNum: 10,
  businessType: "",
  replyRatePct: 46,
  timezone: "America/New_York",
  fromTime: "00:00",
  toTime: "23:59",
  days: [...WEEK_DAYS],
  signature: "{{sender_first_name}}",
  warmupSignature: true,
};

/**
 * What runs started before the settings tab existed applied, and still apply:
 * they kept no copy of their own, and a new default must not reach into a
 * run that is already going.
 */
export const LEGACY_WARMUP_SETTINGS: WarmupSettings = {
  ...DEFAULT_WARMUP_SETTINGS,
  timezone: "Asia/Singapore",
  signature: "",
  warmupSignature: false,
};

export const MAX_SIGNATURE_LENGTH = 5000;

/** The limits the form and the server both hold to. */
export const WARMUP_LIMITS = {
  // Plusvibe's own cap on the Daily Warmup Limit.
  dailyLimit: { min: 1, max: 50 },
  paceIncrement: { min: 1, max: 50 },
  randomizeNum: { min: 1, max: 50 },
  replyRatePct: { min: 0, max: 100 },
} as const;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const asNumber = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);

/**
 * Checks settings as they arrive from the form. Every problem is named, so the
 * form can say what to fix; nothing half-valid is ever saved.
 */
export function validateWarmupSettings(input: unknown): { settings: WarmupSettings | null; problems: string[] } {
  const src = (input ?? {}) as Record<string, unknown>;
  const problems: string[] = [];
  const whole = (key: keyof WarmupSettings, label: string, min: number, max: number): number => {
    const n = asNumber(src[key]);
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${label} must be a whole number from ${min} to ${max}.`);
      return NaN;
    }
    return n;
  };
  const flag = (key: keyof WarmupSettings, label: string): boolean => {
    if (typeof src[key] !== "boolean") problems.push(`${label} must be on or off.`);
    return src[key] === true;
  };

  const L = WARMUP_LIMITS;
  const initialDailyLimit = whole("initialDailyLimit", "Starting daily limit", L.dailyLimit.min, L.dailyLimit.max);
  const paceIncrement = whole("paceIncrement", "Daily increase", L.paceIncrement.min, L.paceIncrement.max);
  const maxDailyLimit = whole("maxDailyLimit", "Daily Warmup Limit", L.dailyLimit.min, L.dailyLimit.max);
  const slowRampup = flag("slowRampup", "Warmup Email Ramp-Up");
  const randomize = flag("randomize", "Randomized Warm-Up Limit");
  const randomizeNum = whole("randomizeNum", "Range in %", L.randomizeNum.min, L.randomizeNum.max);
  const businessType = typeof src.businessType === "string" ? src.businessType.trim() : "";
  if (businessType && !(BUSINESS_TYPES as readonly string[]).includes(businessType)) {
    problems.push(`"${businessType}" is not one of Plusvibe's business types.`);
  }

  const rate = asNumber(src.replyRatePct);
  if (!Number.isFinite(rate) || rate < L.replyRatePct.min || rate > L.replyRatePct.max) {
    problems.push(`Warmup Reply Rate must be a percentage from ${L.replyRatePct.min} to ${L.replyRatePct.max}.`);
  }
  if (Number.isFinite(initialDailyLimit) && Number.isFinite(maxDailyLimit) && initialDailyLimit > maxDailyLimit) {
    problems.push("The starting daily limit can't be more than the Daily Warmup Limit.");
  }

  const timezone = typeof src.timezone === "string" ? src.timezone.trim() : "";
  if (!timezone || !isTimeZone(timezone)) problems.push(`"${timezone}" is not a time zone. Use a name like Asia/Singapore or Europe/Helsinki.`);
  const fromTime = typeof src.fromTime === "string" ? src.fromTime.trim() : "";
  const toTime = typeof src.toTime === "string" ? src.toTime.trim() : "";
  if (!TIME_RE.test(fromTime)) problems.push("Start time must be a time like 08:00.");
  if (!TIME_RE.test(toTime)) problems.push("End time must be a time like 18:00.");
  if (TIME_RE.test(fromTime) && TIME_RE.test(toTime) && fromTime >= toTime) problems.push("End time must be later than the start time.");

  const rawDays = Array.isArray(src.days) ? src.days.map(String) : [];
  // Kept in week order whatever order they were ticked in.
  const days = WEEK_DAYS.filter((d) => rawDays.includes(d));
  // Plusvibe takes a schedule of at least five days.
  if (days.length < 5) problems.push("The warmup schedule needs at least 5 days.");

  const signature = typeof src.signature === "string" ? src.signature.trim() : "";
  if (src.signature !== undefined && typeof src.signature !== "string") problems.push("The signature must be text.");
  if (signature.length > MAX_SIGNATURE_LENGTH) problems.push(`The signature can be at most ${MAX_SIGNATURE_LENGTH} characters.`);
  const warmupSignature = flag("warmupSignature", "Warmup signature");

  if (problems.length > 0) return { settings: null, problems };
  return {
    settings: {
      initialDailyLimit,
      paceIncrement,
      maxDailyLimit,
      slowRampup,
      randomize,
      randomizeNum,
      businessType,
      // Whole percent to one decimal: 46 → 0.46 exactly on the wire.
      replyRatePct: Math.round(rate * 10) / 10,
      timezone,
      fromTime,
      toTime,
      days,
      signature,
      warmupSignature,
    },
    problems: [],
  };
}

/**
 * Settings read back from disk or from an old run record: anything missing or
 * broken falls back to the default for that field, so a damaged file can
 * never stop warmup from starting.
 */
export function normalizeWarmupSettings(input: unknown): WarmupSettings {
  const src = (input ?? {}) as Partial<Record<keyof WarmupSettings, unknown>>;
  const merged = { ...DEFAULT_WARMUP_SETTINGS } as Record<keyof WarmupSettings, unknown>;
  for (const key of Object.keys(DEFAULT_WARMUP_SETTINGS) as (keyof WarmupSettings)[]) {
    if (src[key] === undefined) continue;
    const trial = { ...DEFAULT_WARMUP_SETTINGS, [key]: src[key] };
    if (validateWarmupSettings(trial).settings) merged[key] = src[key];
  }
  return validateWarmupSettings(merged).settings ?? { ...DEFAULT_WARMUP_SETTINGS };
}

/** A signature as Plusvibe stores it: HTML, so a typed line break becomes <br>. */
export function signatureHtml(signature: string): string {
  return signature
    .trim()
    .split(/\r?\n/)
    .join("<br>");
}

/**
 * The body fields /account/bulk-update takes for these settings.
 *
 * `withSignature: false` leaves both signature fields out, for runs that
 * started before the signature was a setting: they never touched it, and
 * a run keeps doing what it started doing.
 */
export function toPlusvibeWarmup(s: WarmupSettings, { withSignature = true }: { withSignature?: boolean } = {}) {
  const signature = withSignature
    ? {
        ...(s.signature.trim() ? { signature: signatureHtml(s.signature) } : {}),
        warmup_signature: s.warmupSignature ? "yes" : "no",
      }
    : {};
  return {
    ...signature,
    // Left out for the generic type, so it stays whatever the inbox has.
    ...(s.businessType ? { warmup_business_type: s.businessType } : {}),
    warmup_max_daily_limit: s.maxDailyLimit,
    bulk_warmup_is_slow_rampup: s.slowRampup ? "yes" : "no",
    warmup_initial_daily_limit: s.initialDailyLimit,
    warmup_pace_increment: s.paceIncrement,
    warmup_randomize: s.randomize ? "yes" : "no",
    warmup_randomize_num: s.randomizeNum,
    // The API takes 0–1: 46% is 0.46.
    warmup_reply_rate: Math.round(s.replyRatePct * 10) / 1000,
    warmup_schedule: {
      tz: s.timezone,
      from_time: s.fromTime,
      to_time: s.toTime,
      days: [...s.days],
    },
  };
}

/** "18/day, ramp-up from 2 (+3 a day) ±10% · 46% replies · every day, all day (America/New_York) · …" */
export function describeWarmup(s: WarmupSettings): string {
  const ramp = s.slowRampup
    ? `${s.maxDailyLimit}/day, ramp-up from ${s.initialDailyLimit} (+${s.paceIncrement} a day)`
    : `${s.maxDailyLimit}/day, no ramp-up`;
  const vary = s.randomize ? ` ±${s.randomizeNum}%` : "";
  const everyDay = s.days.length === 7;
  const weekdays = s.days.length === 5 && WEEK_DAYS.slice(0, 5).every((d) => s.days.includes(d));
  const when = everyDay ? "every day" : weekdays ? "weekdays" : s.days.map((d) => d.slice(0, 3)).join(", ");
  const hours = s.fromTime === "00:00" && s.toTime === "23:59" ? "all day" : `${s.fromTime}–${s.toTime}`;
  const sig = s.signature.trim()
    ? ` · signature ${s.signature.trim().length > 40 ? "set" : `“${s.signature.trim()}”`}${s.warmupSignature ? ", in warmup emails" : ""}`
    : s.warmupSignature
      ? " · each inbox's own signature, in warmup emails"
      : "";
  const type = s.businessType ? ` · ${s.businessType}` : "";
  return `${ramp}${vary} · ${s.replyRatePct}% replies${type} · ${when}, ${hours} (${s.timezone})${sig}`;
}
