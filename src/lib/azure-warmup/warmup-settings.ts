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

export interface WarmupSettings {
  /** Warmup emails a day to start from. */
  initialDailyLimit: number;
  /** Added each day until the maximum is reached. */
  paceIncrement: number;
  /** The most warmup emails a day. */
  maxDailyLimit: number;
  /** Ramp up gradually rather than starting at the maximum. */
  slowRampup: boolean;
  /** Vary the daily count so it does not look mechanical. */
  randomize: boolean;
  /** How far the daily count may vary, in emails. */
  randomizeNum: number;
  /** Share of warmup emails that get a reply, in percent. */
  replyRatePct: number;
  /** IANA time zone the window is read in, e.g. "Asia/Singapore". */
  timezone: string;
  /** "HH:MM", 24-hour. */
  fromTime: string;
  toTime: string;
  days: WeekDay[];
}

export const DEFAULT_WARMUP_SETTINGS: WarmupSettings = {
  initialDailyLimit: 2,
  paceIncrement: 3,
  maxDailyLimit: 18,
  slowRampup: true,
  randomize: true,
  randomizeNum: 10,
  replyRatePct: 46,
  timezone: "Asia/Singapore",
  fromTime: "00:00",
  toTime: "23:59",
  days: [...WEEK_DAYS],
};

/** The limits the form and the server both hold to. */
export const WARMUP_LIMITS = {
  dailyLimit: { min: 1, max: 100 },
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
  const initialDailyLimit = whole("initialDailyLimit", "Starting emails per day", L.dailyLimit.min, L.dailyLimit.max);
  const paceIncrement = whole("paceIncrement", "Daily increase", L.paceIncrement.min, L.paceIncrement.max);
  const maxDailyLimit = whole("maxDailyLimit", "Maximum emails per day", L.dailyLimit.min, L.dailyLimit.max);
  const slowRampup = flag("slowRampup", "Slow ramp-up");
  const randomize = flag("randomize", "Randomize");
  const randomizeNum = whole("randomizeNum", "Randomize by", L.randomizeNum.min, L.randomizeNum.max);

  const rate = asNumber(src.replyRatePct);
  if (!Number.isFinite(rate) || rate < L.replyRatePct.min || rate > L.replyRatePct.max) {
    problems.push(`Reply rate must be a percentage from ${L.replyRatePct.min} to ${L.replyRatePct.max}.`);
  }
  if (Number.isFinite(initialDailyLimit) && Number.isFinite(maxDailyLimit) && initialDailyLimit > maxDailyLimit) {
    problems.push("Starting emails per day can't be more than the maximum.");
  }

  const timezone = typeof src.timezone === "string" ? src.timezone.trim() : "";
  if (!timezone || !isTimeZone(timezone)) problems.push(`"${timezone}" is not a time zone. Use a name like Asia/Singapore or Europe/Helsinki.`);
  const fromTime = typeof src.fromTime === "string" ? src.fromTime.trim() : "";
  const toTime = typeof src.toTime === "string" ? src.toTime.trim() : "";
  if (!TIME_RE.test(fromTime)) problems.push("Send from must be a time like 08:00.");
  if (!TIME_RE.test(toTime)) problems.push("Send until must be a time like 18:00.");
  if (TIME_RE.test(fromTime) && TIME_RE.test(toTime) && fromTime >= toTime) problems.push("Send until must be later than send from.");

  const rawDays = Array.isArray(src.days) ? src.days.map(String) : [];
  // Kept in week order whatever order they were ticked in.
  const days = WEEK_DAYS.filter((d) => rawDays.includes(d));
  if (days.length === 0) problems.push("Pick at least one day.");

  if (problems.length > 0) return { settings: null, problems };
  return {
    settings: {
      initialDailyLimit,
      paceIncrement,
      maxDailyLimit,
      slowRampup,
      randomize,
      randomizeNum,
      // Whole percent to one decimal: 46 → 0.46 exactly on the wire.
      replyRatePct: Math.round(rate * 10) / 10,
      timezone,
      fromTime,
      toTime,
      days,
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

/** The body fields /account/bulk-update takes for these settings. */
export function toPlusvibeWarmup(s: WarmupSettings) {
  return {
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

/** "2 → 18/day, +3 a day (slow ramp-up) ±10 · 46% replies · every day, all day (Asia/Singapore)" */
export function describeWarmup(s: WarmupSettings): string {
  const ramp = `${s.initialDailyLimit} → ${s.maxDailyLimit}/day, +${s.paceIncrement} a day${s.slowRampup ? " (slow ramp-up)" : ""}`;
  const vary = s.randomize ? ` ±${s.randomizeNum}` : "";
  const everyDay = s.days.length === 7;
  const weekdays = s.days.length === 5 && WEEK_DAYS.slice(0, 5).every((d) => s.days.includes(d));
  const when = everyDay ? "every day" : weekdays ? "weekdays" : s.days.map((d) => d.slice(0, 3)).join(", ");
  const hours = s.fromTime === "00:00" && s.toTime === "23:59" ? "all day" : `${s.fromTime}–${s.toTime}`;
  return `${ramp}${vary} · ${s.replyRatePct}% replies · ${when}, ${hours} (${s.timezone})`;
}
