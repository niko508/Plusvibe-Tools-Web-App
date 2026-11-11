// When the weekly Find Burned run happens, and over which days.
//
// Monday at six in the morning Helsinki time, over the 30 days that ended
// yesterday. Weekly because a domain's figures move slowly: replies arrive
// days after the emails, and 750 sends take a while to build up, so a daily
// run would mostly repeat last week's verdicts — or act on one quiet day.
//
// Pure module — the clock is always passed in — so all of it is unit-tested.

import { SWITCH_TIMEZONE, dateAfter, dateIn, instantAt } from "@/lib/start-outreach/schedule";

export const RUN_TIMEZONE = SWITCH_TIMEZONE;
/** Monday, in JavaScript's numbering. */
export const RUN_WEEKDAY = 1;
export const RUN_HOUR = 6;
/** Days of figures each run reads, ending the day before it runs. */
export const WINDOW_DAYS = 30;

/**
 * The automatic removal refuses to run when more than this share of the rows
 * it judged came out burned, and more than MIN_BURNED_FOR_GUARD of them. That
 * many at once is far likelier to be a problem with the figures than a fleet
 * that burned in a week, and deleting is the one step there's no way back from.
 */
export const MAX_BURNED_SHARE = 0.2;
export const MIN_BURNED_FOR_GUARD = 5;

function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1)).getUTCDay();
}

/** The Monday (YYYY-MM-DD, Helsinki) of the week `at` falls in. Names the week. */
export function weekOf(at: number, tz: string = RUN_TIMEZONE): string {
  const today = dateIn(at, tz);
  const back = (weekdayOf(today) - RUN_WEEKDAY + 7) % 7;
  return back === 0 ? today : dateAfter(at, -back, tz);
}

/** This week's run time: Monday 06:00 Helsinki of the week `at` falls in. */
export function dueThisWeek(at: number, tz: string = RUN_TIMEZONE): number {
  return instantAt(weekOf(at, tz), RUN_HOUR, tz);
}

/** Whether the run is due: past this week's time, and this week not run yet. */
export function isDue(now: number, lastWeek: string | undefined, tz: string = RUN_TIMEZONE): boolean {
  return now >= dueThisWeek(now, tz) && lastWeek !== weekOf(now, tz);
}

/** When the next run will happen. Never in the past unless it is due right now. */
export function nextRunAt(now: number, lastWeek: string | undefined, tz: string = RUN_TIMEZONE): number {
  const due = dueThisWeek(now, tz);
  if (now < due) return due;
  if (lastWeek !== weekOf(now, tz)) return now;
  return instantAt(dateAfter(due, 7, tz), RUN_HOUR, tz);
}

/** The window a run at `at` reads: the 30 days that ended yesterday. */
export function windowFor(at: number, tz: string = RUN_TIMEZONE): { start: string; end: string } {
  return { start: dateAfter(at, -WINDOW_DAYS, tz), end: dateAfter(at, -1, tz) };
}

/**
 * Whether a scan's burned rows may be removed without anyone looking.
 *
 * `judged` counts the rows that got a verdict (burned or ok), not the ones
 * too quiet to judge. Returns the reason when it may not.
 */
export function removalGuard(burned: number, judged: number): string | null {
  if (burned <= MIN_BURNED_FOR_GUARD || judged <= 0) return null;
  if (burned / judged <= MAX_BURNED_SHARE) return null;
  return `${burned} of ${judged} judged came out burned — more than ${Math.round(
    MAX_BURNED_SHARE * 100
  )}% at once, which is likelier a problem with the figures. Nothing was removed; check the scan and remove by hand if it is right.`;
}
