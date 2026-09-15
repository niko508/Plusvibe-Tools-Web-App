// A campaign's "Maximum emails per day" lives on its SCHEDULE, not on the
// campaign: PATCH /campaign/update/campaign refuses a top-level daily_limit
// ('"daily_limit" is not allowed') and takes it as schedules[].daily_limit —
// the same shape /campaign/add/campaign was given. And like `sequences`,
// `schedules` is replaced wholesale, so the limit is set by reading the
// schedules the campaign has, changing that one field on each, and sending
// them all back.
//
// Pure module — the API calls are in daily-limit.ts — so it is unit-tested.

/** The schedule fields the update endpoint takes, as the create endpoint documents them. */
const SCHEDULE_FIELDS = ["name", "days", "timezone", "timing", "start_date", "end_date", "daily_limit"] as const;

export type Schedule = Record<string, unknown>;

/**
 * The schedules on a raw campaign, as an array. The API documents an object
 * and returns an array (see first-campaign/api.ts); both are read.
 */
export function readSchedules(raw: Record<string, unknown> | null | undefined): Schedule[] {
  const s = raw?.schedules;
  if (Array.isArray(s)) return s.filter((x): x is Schedule => !!x && typeof x === "object");
  if (s && typeof s === "object") return [s as Schedule];
  return [];
}

/**
 * The same schedules with the limit set, trimmed to the fields the endpoint
 * accepts. The validation that refused a top-level daily_limit is the strict
 * kind, so anything the API added on the way out (ids, timestamps) is not
 * sent back in.
 */
export function withDailyLimit(schedules: Schedule[], dailyLimit: number): Schedule[] {
  return schedules.map((s) => {
    const out: Schedule = {};
    for (const key of SCHEDULE_FIELDS) if (s[key] !== undefined) out[key] = s[key];
    out.daily_limit = dailyLimit;
    return out;
  });
}

/** The limits a campaign reports, one per schedule, as numbers. */
export function readDailyLimits(raw: Record<string, unknown> | null | undefined): number[] {
  return readSchedules(raw).map((s) => Number(s.daily_limit));
}
