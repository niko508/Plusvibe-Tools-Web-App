// Advanced scheduling: a different sending window (or several) for each day.
//
// Plusvibe's campaign screen calls this Advanced Scheduling. On the wire it is
// two fields of PATCH /campaign/update/campaign:
//
//   use_adv_schedule: true
//   adv_schedule: {
//     timezone: "America/New_York",
//     windows: { "Monday": [{ from: "09:00", to: "12:00" },
//                           { from: "14:00", to: "17:30" }], … },
//     daily_limit: 600
//   }
//
// The plain `schedules` field holds ONE window for a set of days; this holds a
// list per weekday, which is the whole point of it.
//
// The editor works in half-hour SLOTS — 48 a day — because a window can start
// at 09:30 and a grid of whole hours could not say that. Slots are turned into
// windows by merging the adjacent ones, so "09:00–12:00" is one window rather
// than six.
//
// Reading one back is the asymmetry to know about: GET /campaign/list-all does
// not document `adv_schedule`, only the singular `schedule` (day names, one
// from_time/to_time, tz). So weekFromCampaign reads the advanced shape when the
// API does return it and falls back to the simple one, saying which it got —
// and nothing here can confirm an advanced schedule was stored.
//
// Pure module — no API calls — so all of it is unit-tested.

export type Weekday = "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday" | "Saturday" | "Sunday";

/** Monday first, the way the grid reads and the way the API keys them. */
export const WEEKDAYS: Weekday[] = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export const SHORT_DAY: Record<Weekday, string> = {
  Monday: "Mon",
  Tuesday: "Tue",
  Wednesday: "Wed",
  Thursday: "Thu",
  Friday: "Fri",
  Saturday: "Sat",
  Sunday: "Sun",
};

/** Half-hour slots. 48 covers the day; slot i starts at i × 30 minutes. */
export const SLOT_MINUTES = 30;
export const SLOTS_PER_DAY = (24 * 60) / SLOT_MINUTES;

export interface Window {
  /** HH:MM, 24-hour. */
  from: string;
  to: string;
}

export interface WeekSchedule {
  timezone: string;
  windows: Record<Weekday, Window[]>;
}

/** Slots as the grid holds them: one boolean row per day. */
export type WeekSlots = Record<Weekday, boolean[]>;

export const DEFAULT_TIMEZONE = "America/New_York";

/** The zones offered in the picker. The campaign's own is added when it isn't here. */
export const TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Dublin",
  "Europe/Berlin",
  "Europe/Madrid",
  "Europe/Helsinki",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Hong_Kong",
  "Asia/Tokyo",
  "Australia/Sydney",
  "UTC",
];

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function minutesOf(hhmm: string): number | null {
  const m = HHMM.exec(hhmm.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** "09:30" for slot 19. The end of the last slot is 24:00, which is said as such. */
export function slotTime(slot: number): string {
  const mins = slot * SLOT_MINUTES;
  if (mins >= 24 * 60) return "24:00";
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

/** "9:30am" — for the grid's hour labels and the summary. */
export function pretty(hhmm: string): string {
  const mins = hhmm === "24:00" ? 24 * 60 : minutesOf(hhmm);
  if (mins === null) return hhmm;
  const h24 = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const suffix = h24 < 12 ? "am" : "pm";
  return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, "0")}${suffix}`;
}

export function emptySlots(): WeekSlots {
  return Object.fromEntries(WEEKDAYS.map((d) => [d, Array(SLOTS_PER_DAY).fill(false)])) as WeekSlots;
}

export function emptyWeek(timezone = DEFAULT_TIMEZONE): WeekSchedule {
  const windows = {} as Record<Weekday, Window[]>;
  for (const d of WEEKDAYS) windows[d] = [];
  return { timezone, windows };
}

/** Adjacent slots become one window; a day with none contributes none. */
export function slotsToWindows(slots: boolean[]): Window[] {
  const out: Window[] = [];
  let start: number | null = null;
  for (let i = 0; i <= SLOTS_PER_DAY; i++) {
    const on = i < SLOTS_PER_DAY && slots[i];
    if (on && start === null) start = i;
    if (!on && start !== null) {
      out.push({ from: slotTime(start), to: slotTime(i) });
      start = null;
    }
  }
  return out;
}

/**
 * Windows back to slots. A window that doesn't land on the half hour covers
 * every slot it touches, so a schedule made elsewhere still shows in the grid
 * rather than vanishing.
 */
export function windowsToSlots(windows: Window[]): boolean[] {
  const slots: boolean[] = Array(SLOTS_PER_DAY).fill(false);
  for (const w of windows) {
    const from = minutesOf(w.from);
    const to = w.to === "24:00" ? 24 * 60 : minutesOf(w.to);
    if (from === null || to === null || to <= from) continue;
    const first = Math.floor(from / SLOT_MINUTES);
    const last = Math.ceil(to / SLOT_MINUTES);
    for (let i = first; i < Math.min(last, SLOTS_PER_DAY); i++) slots[i] = true;
  }
  return slots;
}

export function weekToSlots(week: WeekSchedule): WeekSlots {
  return Object.fromEntries(WEEKDAYS.map((d) => [d, windowsToSlots(week.windows[d] ?? [])])) as WeekSlots;
}

export function slotsToWeek(slots: WeekSlots, timezone: string): WeekSchedule {
  return {
    timezone,
    windows: Object.fromEntries(WEEKDAYS.map((d) => [d, slotsToWindows(slots[d] ?? [])])) as Record<Weekday, Window[]>,
  };
}

export function totalSlots(slots: WeekSlots): number {
  return WEEKDAYS.reduce((n, d) => n + (slots[d] ?? []).filter(Boolean).length, 0);
}

// --- Presets ------------------------------------------------------------------
//
// Starting points, named as Plusvibe's own screen names them.

function fill(days: Weekday[], windows: Window[]): WeekSlots {
  const slots = emptySlots();
  for (const d of days) slots[d] = windowsToSlots(windows);
  return slots;
}

const WEEK = WEEKDAYS.slice(0, 5);

export const PRESETS: { key: string; label: string; build: () => WeekSlots }[] = [
  {
    key: "business",
    label: "Business hours",
    build: () => fill(WEEK, [{ from: "09:00", to: "17:00" }]),
  },
  {
    key: "light",
    label: "Light Mon & Fri",
    build: () => {
      const slots = fill(["Tuesday", "Wednesday", "Thursday"], [{ from: "09:00", to: "17:00" }]);
      for (const d of ["Monday", "Friday"] as Weekday[]) slots[d] = windowsToSlots([{ from: "10:00", to: "14:00" }]);
      return slots;
    },
  },
  {
    key: "lunch",
    label: "Skip lunch",
    build: () => fill(WEEK, [{ from: "09:00", to: "12:00" }, { from: "13:00", to: "17:00" }]),
  },
];

// --- Validation and description -------------------------------------------------

/** Problems with a week, in reading order. Empty when it can be sent. */
export function validateWeek(week: WeekSchedule): string[] {
  const problems: string[] = [];
  if (!week.timezone || !/^[A-Za-z]+(?:\/[A-Za-z_+-]+){0,2}$/.test(week.timezone)) {
    problems.push("Advanced scheduling: pick a timezone.");
  }
  let any = false;
  for (const d of WEEKDAYS) {
    const windows = week.windows[d] ?? [];
    if (windows.length > 0) any = true;
    for (const w of windows) {
      const from = minutesOf(w.from);
      const to = w.to === "24:00" ? 24 * 60 : minutesOf(w.to);
      if (from === null || to === null) {
        problems.push(`Advanced scheduling · ${SHORT_DAY[d]}: times read as HH:MM.`);
      } else if (to <= from) {
        problems.push(`Advanced scheduling · ${SHORT_DAY[d]}: a window has to end after it starts.`);
      }
    }
  }
  // A week with nothing selected would stop every campaign it is written to.
  if (!any) problems.push("Advanced scheduling: select at least one sending window.");
  return problems;
}

/** "Mon–Fri 9am–5pm" / "5 days · 7 windows" when the days differ. */
export function describeWeek(week: WeekSchedule): string {
  const active = WEEKDAYS.filter((d) => (week.windows[d] ?? []).length > 0);
  if (active.length === 0) return "no sending windows";
  const key = (d: Weekday) => (week.windows[d] ?? []).map((w) => `${w.from}-${w.to}`).join(",");
  const same = active.every((d) => key(d) === key(active[0]));
  const windows = active.reduce((n, d) => n + (week.windows[d] ?? []).length, 0);
  if (same) {
    const times = (week.windows[active[0]] ?? []).map((w) => `${pretty(w.from)}–${pretty(w.to)}`).join(", ");
    return `${describeDays(active)} ${times}`;
  }
  return `${describeDays(active)} · ${windows} window${windows === 1 ? "" : "s"}`;
}

/** "Mon–Fri", "Mon, Wed, Fri" — a run of days is said as a range. */
export function describeDays(days: Weekday[]): string {
  if (days.length === 0) return "";
  const idx = days.map((d) => WEEKDAYS.indexOf(d)).sort((a, b) => a - b);
  const runs: [number, number][] = [];
  for (const i of idx) {
    const last = runs[runs.length - 1];
    if (last && i === last[1] + 1) last[1] = i;
    else runs.push([i, i]);
  }
  return runs
    .map(([a, b]) =>
      a === b
        ? SHORT_DAY[WEEKDAYS[a]]
        : b === a + 1
          ? `${SHORT_DAY[WEEKDAYS[a]]}, ${SHORT_DAY[WEEKDAYS[b]]}`
          : `${SHORT_DAY[WEEKDAYS[a]]}–${SHORT_DAY[WEEKDAYS[b]]}`
    )
    .join(", ");
}

// --- Carrying a week through the settings catalogue ------------------------------
//
// A setting's value is a string or a number, so a week travels as JSON. That
// keeps the change list, the job payload and the stored record one shape.

export function stringifyWeek(week: WeekSchedule): string {
  return JSON.stringify({ timezone: week.timezone, windows: week.windows });
}

export function parseWeek(value: unknown): WeekSchedule | null {
  if (value && typeof value === "object" && "windows" in value) return normalizeWeek(value);
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    return normalizeWeek(JSON.parse(value));
  } catch {
    return null;
  }
}

function normalizeWeek(raw: unknown): WeekSchedule | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { timezone?: unknown; windows?: unknown };
  const timezone = typeof r.timezone === "string" && r.timezone.trim() ? r.timezone.trim() : DEFAULT_TIMEZONE;
  const windows = {} as Record<Weekday, Window[]>;
  const src = (r.windows ?? {}) as Record<string, unknown>;
  for (const d of WEEKDAYS) {
    const list = Array.isArray(src[d]) ? (src[d] as unknown[]) : [];
    windows[d] = list
      .map((w) => {
        if (!w || typeof w !== "object") return null;
        const { from, to } = w as { from?: unknown; to?: unknown };
        return typeof from === "string" && typeof to === "string" ? { from: from.trim(), to: to.trim() } : null;
      })
      .filter((w): w is Window => w !== null);
  }
  return { timezone, windows };
}

/**
 * The two fields the API takes. Both limits are required inside
 * adv_schedule, so the campaign's own are carried through rather than
 * invented — this tool sets the schedule, not the volume.
 *
 * `daily_limit_new_lead` is required too, but nullable: the live API refuses
 * a body without it ('"adv_schedule.daily_limit_new_lead" is required') and
 * documents null as "no separate new-lead cap". So the campaign's own cap is
 * sent when it reports one, and null otherwise.
 */
export function advScheduleBody(week: WeekSchedule, dailyLimit: number | null, newLeadLimit: number | null = null): Record<string, unknown> {
  const windows = {} as Record<string, Window[]>;
  for (const d of WEEKDAYS) {
    const list = week.windows[d] ?? [];
    if (list.length > 0) windows[d] = list;
  }
  const adv: Record<string, unknown> = { timezone: week.timezone, windows };
  if (dailyLimit !== null) adv.daily_limit = dailyLimit;
  adv.daily_limit_new_lead = newLeadLimit;
  return { use_adv_schedule: true, adv_schedule: adv };
}

/**
 * The limits a campaign reports, to carry into its advanced schedule. The
 * listing puts them on the campaign; an advanced schedule it does report
 * carries its own, which win. A new-lead cap of 0 is "no cap", the way the
 * rest of this app reads it, and goes out as null.
 */
export function limitsOf(raw: Record<string, unknown> | null | undefined): { dailyLimit: number | null; newLeadLimit: number | null } {
  const adv = (raw?.adv_schedule ?? {}) as Record<string, unknown>;
  const pick = (k: string): unknown => (adv[k] !== undefined && adv[k] !== null ? adv[k] : raw?.[k]);
  const num = (v: unknown): number | null => {
    if (v === undefined || v === null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const newLead = num(pick("daily_limit_new_lead"));
  return {
    dailyLimit: num(pick("daily_limit")),
    newLeadLimit: newLead !== null && newLead > 0 ? newLead : null,
  };
}

export interface CampaignWeek {
  week: WeekSchedule;
  /**
   * True when the campaign reported an advanced schedule, so this is exactly
   * what it runs. False when it was rebuilt from the simple one-window
   * schedule, which is all the documented listing returns.
   */
  exact: boolean;
}

/** Day names as the simple schedule reports them, or "1".."7" keys. */
function dayFrom(v: unknown): Weekday | null {
  const s = String(v).trim();
  const byName = WEEKDAYS.find((d) => d.toLowerCase() === s.toLowerCase() || SHORT_DAY[d].toLowerCase() === s.toLowerCase());
  if (byName) return byName;
  const n = Number(s);
  return Number.isInteger(n) && n >= 1 && n <= 7 ? WEEKDAYS[n - 1] : null;
}

export function daysOf(raw: unknown): Weekday[] {
  if (Array.isArray(raw)) return raw.map(dayFrom).filter((d): d is Weekday => d !== null);
  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>)
      .filter(([, on]) => !!on)
      .map(([k]) => dayFrom(k))
      .filter((d): d is Weekday => d !== null);
  }
  return [];
}

/**
 * A campaign's schedule as a week, for copying one campaign's onto others.
 *
 * The advanced shape is used when the campaign reports it — undocumented in
 * the listing, but read first so this becomes exact the day it appears.
 * Otherwise the simple schedule is spread across its days as one window each.
 */
export function weekFromCampaign(raw: Record<string, unknown> | null | undefined): CampaignWeek | null {
  if (!raw) return null;

  // An advanced schedule the campaign has switched off is kept by the API but
  // not run, so it is not what "copy this campaign's schedule" means.
  const adv = raw.use_adv_schedule === false ? null : raw.adv_schedule;
  if (adv && typeof adv === "object") {
    const a = adv as { timezone?: unknown; windows?: unknown };
    const week = normalizeWeek({ timezone: a.timezone, windows: a.windows });
    if (week && WEEKDAYS.some((d) => week.windows[d].length > 0)) return { week, exact: true };
  }

  const s = (raw.schedule ?? {}) as Record<string, unknown>;
  const timing = (s.timing ?? {}) as Record<string, unknown>;
  const from = String(s.from_time ?? timing.from ?? "").trim();
  const to = String(s.to_time ?? timing.to ?? "").trim();
  const timezone = String(s.tz ?? s.timezone ?? "").trim() || DEFAULT_TIMEZONE;
  const days = daysOf(s.days);
  if (!from || !to || days.length === 0) return null;

  const week = emptyWeek(timezone);
  for (const d of days) week.windows[d] = [{ from, to }];
  return { week, exact: false };
}
