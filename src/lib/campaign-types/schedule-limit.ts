// A campaign's "Maximum emails per day" is set through its schedule, and the
// API speaks the schedule two ways:
//
//   read  GET /campaign/list-all     "schedule": { days: ["Monday", …],
//                                                  from_time, to_time, tz }
//                                    with daily_limit, daily_limit_new_lead,
//                                    camp_st_date, camp_end_date on the campaign
//   write PATCH /campaign/update/campaign
//                                    "schedules": [{ daily_limit, days: {"1": true … "7"},
//                                                    timezone, timing: {from, to},
//                                                    start_date, end_date?,
//                                                    daily_limit_new_lead? }]
//
// There is no top-level daily_limit on the write side ('"daily_limit" is not
// allowed'), and no "schedules" on the read side. So setting the limit is:
// read the schedule as it comes, translate it, change the one number, send
// it back. Every field the write side requires (days, timezone, timing,
// start_date) is taken from what the campaign already has, so nothing else
// about the schedule moves.
//
// Pure module — the API calls are in daily-limit.ts — so it is unit-tested.

type Raw = Record<string, unknown>;

/** The schedule as this module holds it between reading and writing. */
export interface ReadSchedule {
  /** Write form: "1" = Monday … "7" = Sunday, only the sending days present. */
  days: Record<string, boolean>;
  timezone: string;
  from: string;
  to: string;
  startDate?: string;
  endDate?: string;
  /** Only when the campaign has a real cap; 0 on the write side means "no new leads". */
  newLeadLimit?: number;
}

const DAY_NUMBER: Record<string, string> = {
  monday: "1",
  tuesday: "2",
  wednesday: "3",
  thursday: "4",
  friday: "5",
  saturday: "6",
  sunday: "7",
};

/**
 * Days in the write form, from any of the ways they come: day names, day
 * numbers, or an object keyed either way. Null when there are none.
 */
export function toDaysObject(days: unknown): Record<string, boolean> | null {
  const out: Record<string, boolean> = {};
  const key = (d: unknown): string | null => {
    const s = String(d).trim();
    return DAY_NUMBER[s.toLowerCase()] ?? (/^[1-7]$/.test(s) ? s : null);
  };
  if (Array.isArray(days)) {
    for (const d of days) {
      const k = key(d);
      if (k) out[k] = true;
    }
  } else if (days && typeof days === "object") {
    for (const [k, v] of Object.entries(days as Record<string, unknown>)) {
      const kk = key(k);
      if (kk && v) out[kk] = true;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const dateStr = (v: unknown): string | undefined =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v.trim()) ? v.trim().slice(0, 10) : undefined;

/** The schedule object on a raw campaign, whichever key it is under. */
function scheduleObject(raw: Raw): Raw {
  const single = raw.schedule;
  if (single && typeof single === "object" && !Array.isArray(single)) return single as Raw;
  const many = raw.schedules;
  if (Array.isArray(many) && many[0] && typeof many[0] === "object") return many[0] as Raw;
  if (many && typeof many === "object") return many as Raw;
  return {};
}

/**
 * The campaign's schedule, read from wherever the API put it. Null when the
 * campaign reports no days, timezone or send window — there is then nothing
 * to build a write from.
 */
export function readSchedule(raw: Raw | null | undefined): ReadSchedule | null {
  if (!raw) return null;
  const s = scheduleObject(raw);
  // Schedule fields first, then the campaign itself: list-all puts the limit
  // and the dates beside the schedule rather than in it.
  const get = (k: string): unknown => (s[k] !== undefined ? s[k] : raw[k]);
  const timing = (get("timing") ?? {}) as Raw;
  const days = toDaysObject(get("days"));
  const timezone = str(get("tz") ?? get("timezone"));
  const from = str(get("from_time") ?? timing.from);
  const to = str(get("to_time") ?? timing.to);
  if (!days || !timezone || !from || !to) return null;
  const newLead = Number(get("daily_limit_new_lead"));
  return {
    days,
    timezone,
    from,
    to,
    startDate: dateStr(get("camp_st_date") ?? get("start_date")),
    endDate: dateStr(get("camp_end_date") ?? get("end_date")),
    ...(Number.isFinite(newLead) && newLead > 0 ? { newLeadLimit: newLead } : {}),
  };
}

/** The limit a campaign reports, from the schedule or the campaign. Null when it doesn't. */
export function readDailyLimit(raw: Raw | null | undefined): number | null {
  if (!raw) return null;
  const s = scheduleObject(raw);
  const n = Number(s.daily_limit !== undefined ? s.daily_limit : raw.daily_limit);
  return Number.isFinite(n) ? n : null;
}

/**
 * The write form of a schedule, with the limit set. `startDate` is what the
 * live API insists on even though the docs call it optional, so the caller
 * supplies one — the campaign's own, or today.
 */
export function scheduleForWrite(s: ReadSchedule, dailyLimit: number, startDate: string): Raw {
  const out: Raw = {
    daily_limit: dailyLimit,
    days: s.days,
    timezone: s.timezone,
    timing: { from: s.from, to: s.to },
    start_date: startDate,
  };
  if (s.endDate) out.end_date = s.endDate;
  if (s.newLeadLimit !== undefined) out.daily_limit_new_lead = s.newLeadLimit;
  return out;
}

/** Today as YYYY-MM-DD in a timezone — en-CA formats exactly that way. */
export function todayIn(tz: string, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}
