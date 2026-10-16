// When a batch moves onto its week 2 settings.
//
// Seven days after the run, at six in the morning Helsinki time — early enough
// that the new numbers are in place before any sending window opens, and on
// the clock the people running this actually work to.
//
// Helsinki is EET/EEST, so the offset moves twice a year. Everything here goes
// through the timezone rather than adding a fixed number of hours: a switch
// scheduled the week before a clock change still happens at six.
//
// Pure module — the clock is always passed in — so all of it is unit-tested.

import { WEEK_LENGTH_DAYS } from "./week-settings";

/** The clock the week 2 switch is set by. */
export const SWITCH_TIMEZONE = "Europe/Helsinki";
/** Early morning: before the first sending window of the day. */
export const SWITCH_HOUR = 6;

const DAY_MS = 86_400_000;

/** A date as YYYY-MM-DD in a timezone — en-CA formats exactly that way. */
export function dateIn(at: number, tz: string = SWITCH_TIMEZONE): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(at));
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

/**
 * How far ahead of UTC a timezone is at a given instant, in milliseconds.
 *
 * Read by formatting the instant in that zone and comparing it with the same
 * wall-clock read as UTC — which is what makes the rest of this DST-proof
 * without a timezone library.
 */
export function offsetMs(at: number, tz: string = SWITCH_TIMEZONE): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(at));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
    // Intl renders midnight as hour 24 in some engines; both read as the same day.
    const hour = get("hour") % 24;
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
    return asUtc - Math.floor(at / 1000) * 1000;
  } catch {
    return 0;
  }
}

/**
 * The instant at which a timezone's wall clock reads `date` at `hour`:00.
 *
 * Solved rather than computed: a first guess treats the wall time as UTC, the
 * zone's offset at that guess corrects it, and a second pass catches the case
 * where the correction itself crossed a clock change. On the night a clock
 * springs forward the named hour may not exist at all, and the result then
 * lands on the instant the clock reaches it — later that morning, never the
 * day before.
 */
export function instantAt(date: string, hour: number, tz: string = SWITCH_TIMEZONE): number {
  const [y, m, d] = date.split("-").map(Number);
  const wall = Date.UTC(y, (m || 1) - 1, d || 1, hour, 0, 0);
  let guess = wall - offsetMs(wall, tz);
  // One correction is enough except across a transition, where the offset at
  // the guess differs from the offset at the answer; a second pass settles it.
  guess = wall - offsetMs(guess, tz);
  return guess;
}

/** The date `days` calendar days after the one `at` falls on, in `tz`. */
export function dateAfter(at: number, days: number, tz: string = SWITCH_TIMEZONE): string {
  // Stepped from local noon so a day's length changing by an hour can never
  // skip or repeat a date.
  const noon = instantAt(dateIn(at, tz), 12, tz);
  return dateIn(noon + days * DAY_MS, tz);
}

/**
 * When a batch started now should move onto its week 2 settings.
 *
 * Always a future instant: a run at seven in the morning is seven days and a
 * few hours away, not seven days minus one hour.
 */
export function week2DueAt(startedAt: number, tz: string = SWITCH_TIMEZONE): number {
  let due = instantAt(dateAfter(startedAt, WEEK_LENGTH_DAYS, tz), SWITCH_HOUR, tz);
  // Only reachable if a run happened before 06:00 on a day the arithmetic
  // rounded down; one more day is the honest answer, never the past.
  while (due <= startedAt) due = instantAt(dateAfter(due, 1, tz), SWITCH_HOUR, tz);
  return due;
}

/** "Mon 28 Sep, 06:00 Helsinki" — how the Scheduled list says when. */
export function describeDue(at: number, tz: string = SWITCH_TIMEZONE): string {
  try {
    const f = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(at));
    return `${f} Helsinki`;
  } catch {
    return new Date(at).toISOString();
  }
}

/** Whole days until a switch, for the "in 6 days" line. Never negative. */
export function daysUntil(dueAt: number, now: number, tz: string = SWITCH_TIMEZONE): number {
  const from = dateIn(now, tz);
  const to = dateIn(dueAt, tz);
  const diff = Math.round((instantAt(to, 12, tz) - instantAt(from, 12, tz)) / DAY_MS);
  return Math.max(0, diff);
}
