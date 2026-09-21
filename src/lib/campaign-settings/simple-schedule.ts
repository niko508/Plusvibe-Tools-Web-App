// The plain sending schedule: a set of days, one daily window, a timezone.
//
// This is the schedule Plusvibe's campaign screen shows with Advanced
// Scheduling switched off. On the wire the API speaks it two ways:
//
//   read   GET /campaign/list-all      schedule: { days: ["Monday", …],
//                                                 from_time, to_time, tz }
//                                      with daily_limit, daily_limit_new_lead,
//                                      camp_st_date, camp_end_date beside it
//   write  PATCH /campaign/update/campaign
//                                      use_adv_schedule: false
//                                      schedules: [{ daily_limit, daily_limit_new_lead?,
//                                                    days: { "1": true … "7" },
//                                                    timezone, timing: { from, to },
//                                                    start_date, end_date? }]
//
// The write side wants the limits and the dates INSIDE the schedule, so they
// are carried over from what the campaign reports — this setting changes the
// days and the window, nothing else. `use_adv_schedule: false` goes with it
// so a campaign on advanced scheduling comes back to the plain one.
//
// Pure module — no API calls — so all of it is unit-tested.

import { DEFAULT_TIMEZONE, SHORT_DAY, WEEKDAYS, daysOf, describeDays, limitsOf, minutesOf, pretty, slotTime, type Weekday, type WeekSchedule } from "./schedule";

export interface SimpleSchedule {
  /** In week order, no repeats. */
  days: Weekday[];
  timezone: string;
  /** HH:MM, 24-hour. */
  from: string;
  to: string;
}

/** Every half hour, the way Plusvibe's own time pickers step. */
export const TIME_OPTIONS: string[] = Array.from({ length: 48 }, (_, i) => slotTime(i));

export const DEFAULT_SIMPLE: SimpleSchedule = {
  days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
  timezone: DEFAULT_TIMEZONE,
  from: "09:00",
  to: "17:00",
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "8:30" → "08:30"; anything that isn't a time stays as it came, for validation to name. */
function timeOf(v: unknown): string {
  const s = String(v ?? "").trim();
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : s;
}

/** Whatever was given, as a schedule: days de-duplicated into week order. Null when it isn't one. */
export function normalizeSimple(raw: unknown): SimpleSchedule | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { days?: unknown; timezone?: unknown; from?: unknown; to?: unknown };
  const wanted = new Set(daysOf(r.days));
  return {
    days: WEEKDAYS.filter((d) => wanted.has(d)),
    timezone: typeof r.timezone === "string" && r.timezone.trim() ? r.timezone.trim() : DEFAULT_TIMEZONE,
    from: timeOf(r.from),
    to: timeOf(r.to),
  };
}

export function stringifySimple(s: SimpleSchedule): string {
  const n = normalizeSimple(s) ?? s;
  return JSON.stringify({ days: n.days, timezone: n.timezone, from: n.from, to: n.to });
}

export function parseSimple(value: unknown): SimpleSchedule | null {
  if (value && typeof value === "object") return normalizeSimple(value);
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    return normalizeSimple(JSON.parse(value));
  } catch {
    return null;
  }
}

/** Problems, in reading order. Empty when it can be sent. */
export function validateSimple(s: SimpleSchedule): string[] {
  const problems: string[] = [];
  if (!s.timezone || !/^[A-Za-z]+(?:\/[A-Za-z_+-]+){0,2}$/.test(s.timezone)) problems.push("Sending schedule: pick a timezone.");
  if (s.days.length === 0) problems.push("Sending schedule: pick at least one day.");
  const from = HHMM.test(s.from) ? minutesOf(s.from) : null;
  const to = HHMM.test(s.to) ? minutesOf(s.to) : null;
  if (from === null || to === null) problems.push("Sending schedule: times read as HH:MM.");
  else if (to <= from) problems.push("Sending schedule: the end time has to be after the start time.");
  return problems;
}

/** "Mon–Fri 8:30am–3pm" */
export function describeSimple(s: SimpleSchedule): string {
  const days = describeDays(s.days) || "no days";
  return `${days} ${pretty(s.from)}–${pretty(s.to)}`;
}

/**
 * The plain schedule a campaign reports, from the listing's `schedule`
 * (or a write-shaped `schedules[0]`, should the API ever return that). Null
 * when it reports none.
 */
export function simpleFromCampaign(raw: Record<string, unknown> | null | undefined): SimpleSchedule | null {
  if (!raw) return null;
  const single = raw.schedule;
  const many = raw.schedules;
  const s = (
    single && typeof single === "object" && !Array.isArray(single)
      ? single
      : Array.isArray(many) && many[0] && typeof many[0] === "object"
        ? many[0]
        : {}
  ) as Record<string, unknown>;
  const timing = (s.timing ?? {}) as Record<string, unknown>;
  const days = daysOf(s.days);
  const from = timeOf(s.from_time ?? timing.from);
  const to = timeOf(s.to_time ?? timing.to);
  const timezone = String(s.tz ?? s.timezone ?? "").trim() || DEFAULT_TIMEZONE;
  if (days.length === 0 || !HHMM.test(from) || !HHMM.test(to)) return null;
  return normalizeSimple({ days, timezone, from, to });
}

/**
 * A week as a plain schedule, when it is one: the same single window on
 * every day that sends. Null when the days differ, or a day has two windows
 * — that week needs advanced scheduling.
 */
export function simpleFromWeek(week: WeekSchedule): SimpleSchedule | null {
  const days = WEEKDAYS.filter((d) => (week.windows[d] ?? []).length > 0);
  if (days.length === 0) return null;
  const first = week.windows[days[0]];
  if (first.length !== 1) return null;
  const same = days.every((d) => {
    const w = week.windows[d];
    return w.length === 1 && w[0].from === first[0].from && w[0].to === first[0].to;
  });
  if (!same) return null;
  return normalizeSimple({ days, timezone: week.timezone, from: first[0].from, to: first[0].to });
}

/** Today as YYYY-MM-DD in a timezone — en-CA formats exactly that way. */
export function todayIn(tz: string, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

const dateStr = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v.trim()) ? v.trim().slice(0, 10) : null);

/**
 * The write. Everything the endpoint requires besides the days and the
 * window is taken from the campaign — its daily limit and new-lead cap, its
 * start date (today in the schedule's zone when it has none, since the live
 * API insists on one) and its end date when it has one.
 */
export function simpleScheduleBody(s: SimpleSchedule, raw: Record<string, unknown> | null | undefined, now = new Date()): Record<string, unknown> {
  const n = normalizeSimple(s) ?? s;
  const days: Record<string, boolean> = {};
  for (const d of n.days) days[String(WEEKDAYS.indexOf(d) + 1)] = true;
  const { dailyLimit, newLeadLimit } = limitsOf(raw);
  const schedule: Record<string, unknown> = {
    ...(dailyLimit !== null ? { daily_limit: dailyLimit } : {}),
    ...(newLeadLimit !== null ? { daily_limit_new_lead: newLeadLimit } : {}),
    days,
    timezone: n.timezone,
    timing: { from: n.from, to: n.to },
    start_date: dateStr(raw?.camp_st_date ?? raw?.start_date) ?? todayIn(n.timezone, now),
  };
  const end = dateStr(raw?.camp_end_date ?? raw?.end_date);
  if (end) schedule.end_date = end;
  return { use_adv_schedule: false, schedules: [schedule] };
}

/** True when the listing says outright that the campaign is NOT on advanced scheduling. */
export function knownPlain(raw: Record<string, unknown> | null | undefined): boolean {
  return raw?.use_adv_schedule === false;
}

export { SHORT_DAY, WEEKDAYS };
