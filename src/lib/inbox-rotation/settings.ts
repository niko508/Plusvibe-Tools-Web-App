// Inbox Rotation: the settings and the per-workspace set-up.
//
// Every workspace has its inboxes tagged Sending Group 1 and Sending Group 2,
// and the rotation moves the sending settings between the two groups on a
// schedule. What each inbox gets depends on which PROFILE it falls in:
//
//   Azure (50)   Microsoft inboxes on domains with 26–50 inboxes
//   Azure (25)   Microsoft inboxes on domains with 25 inboxes or fewer
//   Google       Google inboxes
//
// A profile is five ramp-up cycles and then a maintaining period. Per cycle:
//
//   Day Length      how many days before the rotation switches
//   Daily Sends     the daily campaign email limit
//   Email Interval  the minimum interval between emails, in minutes
//   Warmup Emails   the warmup daily limit while the group is sending
//
// and, once per profile, the warmup daily limit for the group that is NOT
// sending cold — the resting group.
//
// Campaign Email Ramp-Up is always off — it is not a setting here.
//
// This module is the settings and the set-up record. The schedule is in
// schedule.ts, what is in a workspace in inventory.ts, and the writing of it
// all in runner.ts. Pure — the files are in store.ts — so all of it is
// unit-tested and the client imports it for the forms.

export type ProfileKey = "azure50" | "azure25" | "google";

export const PROFILES: { key: ProfileKey; label: string; hint: string }[] = [
  { key: "azure50", label: "Azure (50)", hint: "Microsoft inboxes on domains with 26–50 inboxes" },
  { key: "azure25", label: "Azure (25)", hint: "Microsoft inboxes on domains with 25 inboxes or fewer" },
  { key: "google", label: "Google", hint: "Google inboxes" },
];

export function isProfileKey(v: unknown): v is ProfileKey {
  return v === "azure50" || v === "azure25" || v === "google";
}

export interface Cycle {
  /** Days until the rotation switches. */
  dayLength: number;
  /** Daily campaign email limit. */
  dailySends: number;
  /** Minimum interval between emails, in minutes. */
  emailInterval: number;
  /** Warmup daily limit while sending. */
  warmupEmails: number;
}

export interface Maintaining {
  /** The switch happens somewhere in this range of days. */
  dayLengthMin: number;
  dayLengthMax: number;
  dailySends: number;
  emailInterval: number;
  warmupEmails: number;
}

export interface Resting {
  /** Warmup daily limit for the group that is not sending cold. */
  warmupEmails: number;
}

export interface Profile {
  cycles: Cycle[];
  maintaining: Maintaining;
  resting: Resting;
}

export const CYCLE_COUNT = 5;

/** The one setting that is not a setting: ramp-up stays off on every inbox the rotation touches. */
export const RAMP_UP_DISABLED = { bulk_is_slow_rampup: "no" } as const;

/**
 * Warmup numbers to start from — placeholders, not a plan: the written-up
 * plan gave none, so these are here to be changed.
 */
export const DEFAULT_WARMUP_SENDING = 20;
export const DEFAULT_WARMUP_RESTING = 40;

/** The Azure (50) plan as written up; the other two start from the same numbers until changed. */
export const DEFAULT_PROFILE: Profile = {
  cycles: [
    { dayLength: 1, dailySends: 1, emailInterval: 180, warmupEmails: DEFAULT_WARMUP_SENDING },
    { dayLength: 2, dailySends: 1, emailInterval: 180, warmupEmails: DEFAULT_WARMUP_SENDING },
    { dayLength: 3, dailySends: 2, emailInterval: 180, warmupEmails: DEFAULT_WARMUP_SENDING },
    { dayLength: 4, dailySends: 3, emailInterval: 120, warmupEmails: DEFAULT_WARMUP_SENDING },
    { dayLength: 5, dailySends: 3, emailInterval: 120, warmupEmails: DEFAULT_WARMUP_SENDING },
  ],
  maintaining: { dayLengthMin: 2, dayLengthMax: 5, dailySends: 3, emailInterval: 120, warmupEmails: DEFAULT_WARMUP_SENDING },
  resting: { warmupEmails: DEFAULT_WARMUP_RESTING },
};

export interface RotationSettings {
  profiles: Record<ProfileKey, Profile>;
  updatedAt: number;
}

export const DEFAULT_SETTINGS: RotationSettings = {
  profiles: { azure50: DEFAULT_PROFILE, azure25: DEFAULT_PROFILE, google: DEFAULT_PROFILE },
  updatedAt: 0,
};

// --- Validation ---------------------------------------------------------------

const MAX_DAYS = 365;
const MAX_SENDS = 10_000;
const MAX_INTERVAL = 24 * 60;
const MAX_WARMUP = 1000;

/** A whole number in range, or the problem in words. */
function whole(raw: unknown, label: string, min: number, max: number): { value?: number; error?: string } {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
    return { error: `${label}: enter a number.` };
  }
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return { error: `${label}: enter a number.` };
  if (!Number.isInteger(n)) return { error: `${label}: use a whole number.` };
  if (n < min) return { error: `${label}: must be at least ${min}.` };
  if (n > max) return { error: `${label}: ${max.toLocaleString()} is the most.` };
  return { value: n };
}

/** The problems with one cycle as typed, in reading order. */
export function validateCycle(c: Partial<Record<keyof Cycle, unknown>>, label: string): string[] {
  return [
    whole(c.dayLength, `${label} · Day Length`, 1, MAX_DAYS).error,
    whole(c.dailySends, `${label} · Daily Sends`, 0, MAX_SENDS).error,
    whole(c.emailInterval, `${label} · Email Interval`, 1, MAX_INTERVAL).error,
    whole(c.warmupEmails, `${label} · Warmup Emails`, 0, MAX_WARMUP).error,
  ].filter((e): e is string => !!e);
}

export function validateMaintaining(m: Partial<Record<keyof Maintaining, unknown>>, label: string): string[] {
  const min = whole(m.dayLengthMin, `${label} · Day Length from`, 1, MAX_DAYS);
  const max = whole(m.dayLengthMax, `${label} · Day Length to`, 1, MAX_DAYS);
  const problems = [
    min.error,
    max.error,
    whole(m.dailySends, `${label} · Daily Sends`, 0, MAX_SENDS).error,
    whole(m.emailInterval, `${label} · Email Interval`, 1, MAX_INTERVAL).error,
    whole(m.warmupEmails, `${label} · Warmup Emails`, 0, MAX_WARMUP).error,
  ].filter((e): e is string => !!e);
  if (min.value !== undefined && max.value !== undefined && min.value > max.value) {
    problems.push(`${label} · Day Length: the range runs from the smaller number to the larger.`);
  }
  return problems;
}

export function validateResting(r: Partial<Record<keyof Resting, unknown>>, label: string): string[] {
  return [whole(r.warmupEmails, `${label} · Warmup Emails`, 0, MAX_WARMUP).error].filter((e): e is string => !!e);
}

/** A profile as it may arrive: typed, or stored by an earlier build. */
export interface ProfileInput {
  cycles?: unknown;
  maintaining?: unknown;
  resting?: unknown;
}

/** Every problem in a profile as typed. Empty when it can be saved. */
export function validateProfile(p: ProfileInput, label: string): string[] {
  const problems: string[] = [];
  const cycles = Array.isArray(p.cycles) ? p.cycles : [];
  if (cycles.length !== CYCLE_COUNT) problems.push(`${label}: ${CYCLE_COUNT} cycles are needed.`);
  cycles.slice(0, CYCLE_COUNT).forEach((c, i) => {
    problems.push(...validateCycle((c ?? {}) as Partial<Record<keyof Cycle, unknown>>, `${label} · Cycle ${i + 1}`));
  });
  problems.push(
    ...validateMaintaining(
      ((p.maintaining ?? {}) as Partial<Record<keyof Maintaining, unknown>>),
      `${label} · Maintaining`
    )
  );
  problems.push(
    ...validateResting(((p.resting ?? {}) as Partial<Record<keyof Resting, unknown>>), `${label} · Not sending cold`)
  );
  return problems;
}

/** A profile as typed, with every number a number. Only call once it validates. */
export function cleanProfile(p: {
  cycles: Partial<Record<keyof Cycle, unknown>>[];
  maintaining: Partial<Record<keyof Maintaining, unknown>>;
  resting: Partial<Record<keyof Resting, unknown>>;
}): Profile {
  return {
    cycles: p.cycles.slice(0, CYCLE_COUNT).map((c) => ({
      dayLength: Number(c.dayLength),
      dailySends: Number(c.dailySends),
      emailInterval: Number(c.emailInterval),
      warmupEmails: Number(c.warmupEmails),
    })),
    maintaining: {
      dayLengthMin: Number(p.maintaining.dayLengthMin),
      dayLengthMax: Number(p.maintaining.dayLengthMax),
      dailySends: Number(p.maintaining.dailySends),
      emailInterval: Number(p.maintaining.emailInterval),
      warmupEmails: Number(p.maintaining.warmupEmails),
    },
    resting: { warmupEmails: Number(p.resting.warmupEmails) },
  };
}

/**
 * A stored profile with the warmup fields filled in where a file written
 * before they existed has none. Only the missing fields are touched, so the
 * numbers someone did set are kept rather than thrown away with the profile.
 */
export function withWarmupDefaults(p: ProfileInput): ProfileInput {
  const fill = (o: unknown, value: number) =>
    o && typeof o === "object" && (o as Record<string, unknown>).warmupEmails === undefined
      ? { ...(o as Record<string, unknown>), warmupEmails: value }
      : o;
  return {
    cycles: Array.isArray(p.cycles) ? p.cycles.map((c) => fill(c, DEFAULT_WARMUP_SENDING)) : p.cycles,
    maintaining: fill(p.maintaining, DEFAULT_WARMUP_SENDING),
    resting: p.resting === undefined ? { warmupEmails: DEFAULT_WARMUP_RESTING } : p.resting,
  };
}

/**
 * Whatever was stored, read as settings. A profile that does not validate is
 * the default — a half-written file must not become a plan nobody wrote.
 */
export function normalizeSettings(raw: Partial<RotationSettings> | null | undefined): RotationSettings {
  const profiles = (raw?.profiles ?? {}) as Partial<Record<ProfileKey, unknown>>;
  const out = {} as Record<ProfileKey, Profile>;
  for (const { key, label } of PROFILES) {
    const stored = profiles[key] as ProfileInput | undefined;
    const p = stored ? withWarmupDefaults(stored) : undefined;
    out[key] =
      p && validateProfile(p, label).length === 0
        ? cleanProfile(p as Parameters<typeof cleanProfile>[0])
        : DEFAULT_PROFILE;
  }
  return { profiles: out, updatedAt: typeof raw?.updatedAt === "number" ? raw.updatedAt : 0 };
}

/** "1 day · 1/day · every 180 min · warmup 20" */
export function describeCycle(c: Cycle): string {
  return `${c.dayLength} day${c.dayLength === 1 ? "" : "s"} · ${c.dailySends}/day · every ${c.emailInterval} min · warmup ${c.warmupEmails}`;
}

// --- The per-workspace set-up ---------------------------------------------------

export type Group = 1 | 2;

export const GROUPS: { key: Group; label: string }[] = [
  { key: 1, label: "Sending Group 1" },
  { key: 2, label: "Sending Group 2" },
];

/** The tag an inbox carries to be in a group, as it is named in Plusvibe. */
export const GROUP_TAG_NAMES: Record<Group, string> = { 1: "Sending Group 1", 2: "Sending Group 2" };

export function otherGroup(g: Group): Group {
  return g === 1 ? 2 : 1;
}

/** Where a workspace starts: one of the five cycles, or the maintaining period. */
export type Stage = 1 | 2 | 3 | 4 | 5 | "maintaining";

export const STAGES: { key: Stage; label: string }[] = [
  { key: 1, label: "Cycle 1" },
  { key: 2, label: "Cycle 2" },
  { key: 3, label: "Cycle 3" },
  { key: 4, label: "Cycle 4" },
  { key: 5, label: "Cycle 5" },
  { key: "maintaining", label: "Maintaining period" },
];

export function isGroup(v: unknown): v is Group {
  return v === 1 || v === 2;
}
export function isStage(v: unknown): v is Stage {
  return v === "maintaining" || v === 1 || v === 2 || v === 3 || v === 4 || v === 5;
}
export function stageLabel(stage: Stage): string {
  return STAGES.find((s) => s.key === stage)?.label ?? String(stage);
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
export function isYmd(v: unknown): v is string {
  return typeof v === "string" && YMD.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
}

/** An inbox's kind for the rotation: one of the three profiles, or none of them. */
export type InboxClass = ProfileKey | "other";
export const INBOX_CLASSES: InboxClass[] = ["azure50", "azure25", "google", "other"];

/** How many inboxes each group has, by kind. Counts only — ids are read fresh each time. */
export interface Inventory {
  fetchedAt: number;
  groups: Record<Group, Record<InboxClass, number>>;
  /** Inboxes in the workspace carrying neither group tag. */
  untagged: number;
  /** Which group tags exist in the workspace. */
  tagsFound: Group[];
}

/** The segment last written to Plusvibe for one profile. */
export interface AppliedSegment {
  /** First day of the segment, YYYY-MM-DD. */
  start: string;
  /** Day after the last, YYYY-MM-DD. */
  end: string;
  group: Group;
  stage: Stage;
  at: number;
}

export interface RunSummary {
  startedAt: number;
  finishedAt?: number;
  /** As-of day the run applied. */
  day: string;
  /** Inboxes written in this run. */
  updated: number;
  errors: string[];
  trigger: "setup" | "manual" | "scheduled";
}

export interface WorkspaceRotation {
  id: string;
  workspaceId: string;
  workspaceName: string;
  /** The group that sends first. */
  startingGroup: Group;
  /** Day 1, YYYY-MM-DD. */
  startDate: string;
  /** Where the workspace starts: a cycle, or the maintaining period. */
  stage: Stage;
  /**
   * The maintaining-period day lengths as they were drawn, per profile. Drawn
   * once and kept, so the schedule is the same however often it is read.
   */
  picks: Partial<Record<ProfileKey, number[]>>;
  inventory?: Inventory;
  applied: Partial<Record<ProfileKey, AppliedSegment>>;
  lastRun?: RunSummary;
  createdAt: number;
  updatedAt: number;
}

export interface SetupInput {
  workspaceId: string;
  workspaceName: string;
  startingGroup: Group;
  startDate: string;
  stage: Stage;
}

/** The problems with a set-up as sent. Empty when it can be saved. */
export function validateSetup(input: Partial<Record<keyof SetupInput, unknown>>): string[] {
  const problems: string[] = [];
  if (typeof input.workspaceId !== "string" || input.workspaceId.trim() === "") problems.push("Pick a workspace.");
  if (!isGroup(input.startingGroup)) problems.push("Pick which sending group starts.");
  if (!isYmd(input.startDate)) problems.push("Pick a start date.");
  if (!isStage(input.stage)) problems.push("Pick the stage to start on.");
  return problems;
}

/** "Sending Group 1 first · from 2026-09-20 · Cycle 3" */
export function describeSetup(r: Pick<WorkspaceRotation, "startingGroup" | "startDate" | "stage">): string {
  return `Sending Group ${r.startingGroup} first · from ${r.startDate} · ${stageLabel(r.stage)}`;
}
