// When each group sends.
//
// A workspace starts on Day 1 with its starting group. In a cycle the
// starting group sends for Day Length days, then the other group for the
// same, and the next cycle begins:
//
//   Cycle 1 (1 day)    Day 1  G1 · Day 2  G2
//   Cycle 2 (2 days)   Day 3  G1 · Day 4  G1 · Day 5  G2 · Day 6  G2
//   Cycle 3 (3 days)   Day 7–9 G1 · Day 10–12 G2
//
// After Cycle 5 comes the maintaining period: a day length is drawn from the
// profile's range, the starting group sends for that many days, then the
// other, then a new length is drawn. Each turn's daily sends are drawn from
// the profile's sends range at the same time. The draws are kept on the
// rotation so the schedule reads the same every time; this module only asks
// for them.
//
// Each profile keeps its own timeline, because each has its own day lengths.
// With the same lengths in every profile — the default — the three timelines
// are one schedule.
//
// Days are calendar days in ROTATION_TIMEZONE. Pure module: no clock, no
// files, so all of it is unit-tested.

import {
  CYCLE_COUNT,
  otherGroup,
  stageLabel,
  type Group,
  type MaintainingPick,
  type Profile,
  type Stage,
} from "./settings";

export const ROTATION_TIMEZONE = "America/New_York";

/** Today as YYYY-MM-DD in a timezone — en-CA formats exactly that way. */
export function todayIn(tz: string = ROTATION_TIMEZONE, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

const DAY_MS = 86_400_000;

function utc(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

export function addDays(ymd: string, n: number): string {
  return new Date(utc(ymd) + n * DAY_MS).toISOString().slice(0, 10);
}

/** b − a, in whole days. */
export function daysBetween(a: string, b: string): number {
  return Math.round((utc(b) - utc(a)) / DAY_MS);
}

/** One stretch of days in which one group sends. */
export interface Segment {
  stage: Stage;
  /** 0-based, for a cycle stage. */
  cycleIndex?: number;
  /** Which maintaining draw this is, for the maintaining stage. */
  pickIndex?: number;
  group: Group;
  /** First day, inclusive. */
  start: string;
  /** Day after the last. */
  end: string;
  length: number;
  /** The daily sends drawn for this turn, in the maintaining stage. */
  sends?: number;
}

export interface Timeline {
  profile: Profile;
  startDate: string;
  startingGroup: Group;
  stage: Stage;
  /** The maintaining draws made so far. */
  picks: MaintainingPick[];
}

export type Position =
  | { kind: "segment"; segment: Segment; dayOfSegment: number }
  /** The day falls in a maintaining draw not made yet: this many are needed. */
  | { kind: "needPicks"; count: number }
  | { kind: "notStarted"; startsIn: number };

/** Where a day falls on a timeline. */
export function positionOn(day: string, tl: Timeline): Position {
  const d = daysBetween(tl.startDate, day);
  if (d < 0) return { kind: "notStarted", startsIn: -d };
  const order: Group[] = [tl.startingGroup, otherGroup(tl.startingGroup)];
  let cursor = 0;
  const at = (partial: Omit<Segment, "start" | "end">): Position => ({
    kind: "segment",
    segment: { ...partial, start: addDays(tl.startDate, cursor), end: addDays(tl.startDate, cursor + partial.length) },
    dayOfSegment: d - cursor + 1,
  });

  const firstCycle = tl.stage === "maintaining" ? CYCLE_COUNT : tl.stage - 1;
  for (let i = firstCycle; i < CYCLE_COUNT; i++) {
    const length = tl.profile.cycles[i].dayLength;
    for (const group of order) {
      if (d < cursor + length) return at({ stage: (i + 1) as Stage, cycleIndex: i, group, length });
      cursor += length;
    }
  }
  for (let k = 0; ; k++) {
    const pick = tl.picks[k];
    if (pick === undefined) return { kind: "needPicks", count: k + 1 };
    const length = pick.days;
    for (const [turn, group] of order.entries()) {
      if (d < cursor + length) {
        // A draw made before the sends range existed has no sends: the low
        // end of the range stands in.
        const sends = pick.sends?.[turn] ?? tl.profile.maintaining.dailySendsMin;
        return at({ stage: "maintaining", pickIndex: k, group, length, sends });
      }
      cursor += length;
    }
  }
}

/** A whole number from lo to hi inclusive. */
function between(lo: number, hi: number, rng: () => number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/** A maintaining draw: a day length, and each turn's daily sends. */
export function drawPick(profile: Profile, rng: () => number = Math.random): MaintainingPick {
  const m = profile.maintaining;
  return {
    days: between(m.dayLengthMin, m.dayLengthMax, rng),
    sends: [between(m.dailySendsMin, m.dailySendsMax, rng), between(m.dailySendsMin, m.dailySendsMax, rng)],
  };
}

/**
 * The picks a day needs, drawn and appended. Returns the same array when
 * nothing was needed, so the caller can tell whether there is anything to
 * persist.
 */
export function ensurePicks(day: string, tl: Timeline, rng: () => number = Math.random): MaintainingPick[] {
  let picks = tl.picks;
  for (;;) {
    const pos = positionOn(day, { ...tl, picks });
    if (pos.kind !== "needPicks") return picks;
    const next = [...picks];
    while (next.length < pos.count) next.push(drawPick(tl.profile, rng));
    picks = next;
  }
}

/** The group sending on each of a run of days — what the worked example reads as. */
export function groupByDay(tl: Timeline, days: number): (Group | null)[] {
  return Array.from({ length: days }, (_, i) => {
    const pos = positionOn(addDays(tl.startDate, i), tl);
    return pos.kind === "segment" ? pos.segment.group : null;
  });
}

/** "Sending Group 1 · Cycle 2 · day 1 of 2 · switches 2026-09-18" */
export function describePosition(pos: Position): string {
  if (pos.kind === "notStarted") return `starts in ${pos.startsIn} day${pos.startsIn === 1 ? "" : "s"}`;
  if (pos.kind === "needPicks") return "maintaining period · day length not drawn yet";
  const s = pos.segment;
  const sends = s.stage === "maintaining" && s.sends !== undefined ? ` · ${s.sends}/day` : "";
  return `Sending Group ${s.group} · ${stageLabel(s.stage)}${sends} · day ${pos.dayOfSegment} of ${s.length} · switches ${s.end}`;
}
