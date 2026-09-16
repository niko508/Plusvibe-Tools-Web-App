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
//
// Campaign Email Ramp-Up is always off — it is not a setting here.
//
// The schedule that applies these is not built yet; this module is the
// settings and the set-up record only. Pure — the files are in store.ts — so
// all of it is unit-tested and the client imports it for the forms.

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
}

export interface Maintaining {
  /** The switch happens somewhere in this range of days. */
  dayLengthMin: number;
  dayLengthMax: number;
  dailySends: number;
  emailInterval: number;
}

export interface Profile {
  cycles: Cycle[];
  maintaining: Maintaining;
}

export const CYCLE_COUNT = 5;

/** The one setting that is not a setting: ramp-up stays off on every inbox the rotation touches. */
export const RAMP_UP_DISABLED = { bulk_is_slow_rampup: "no" } as const;

/** The Azure (50) plan as written up; the other two start from the same numbers until changed. */
export const DEFAULT_PROFILE: Profile = {
  cycles: [
    { dayLength: 1, dailySends: 1, emailInterval: 180 },
    { dayLength: 2, dailySends: 1, emailInterval: 180 },
    { dayLength: 3, dailySends: 2, emailInterval: 180 },
    { dayLength: 4, dailySends: 3, emailInterval: 120 },
    { dayLength: 5, dailySends: 3, emailInterval: 120 },
  ],
  maintaining: { dayLengthMin: 2, dayLengthMax: 5, dailySends: 3, emailInterval: 120 },
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
  ].filter((e): e is string => !!e);
  if (min.value !== undefined && max.value !== undefined && min.value > max.value) {
    problems.push(`${label} · Day Length: the range runs from the smaller number to the larger.`);
  }
  return problems;
}

/** Every problem in a profile as typed. Empty when it can be saved. */
export function validateProfile(p: { cycles?: unknown; maintaining?: unknown }, label: string): string[] {
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
  return problems;
}

/** A profile as typed, with every number a number. Only call once it validates. */
export function cleanProfile(p: { cycles: Partial<Record<keyof Cycle, unknown>>[]; maintaining: Partial<Record<keyof Maintaining, unknown>> }): Profile {
  return {
    cycles: p.cycles.slice(0, CYCLE_COUNT).map((c) => ({
      dayLength: Number(c.dayLength),
      dailySends: Number(c.dailySends),
      emailInterval: Number(c.emailInterval),
    })),
    maintaining: {
      dayLengthMin: Number(p.maintaining.dayLengthMin),
      dayLengthMax: Number(p.maintaining.dayLengthMax),
      dailySends: Number(p.maintaining.dailySends),
      emailInterval: Number(p.maintaining.emailInterval),
    },
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
    const p = profiles[key] as { cycles?: unknown; maintaining?: unknown } | undefined;
    out[key] =
      p && validateProfile(p, label).length === 0
        ? cleanProfile(p as Parameters<typeof cleanProfile>[0])
        : DEFAULT_PROFILE;
  }
  return { profiles: out, updatedAt: typeof raw?.updatedAt === "number" ? raw.updatedAt : 0 };
}

/** "1 day · 1 send/day · every 180 min" */
export function describeCycle(c: Cycle): string {
  return `${c.dayLength} day${c.dayLength === 1 ? "" : "s"} · ${c.dailySends}/day · every ${c.emailInterval} min`;
}

// --- The per-workspace set-up ---------------------------------------------------

export type Group = 1 | 2;
export type Phase = "rampUp" | "maintaining";

export const GROUPS: { key: Group; label: string }[] = [
  { key: 1, label: "Sending Group 1" },
  { key: 2, label: "Sending Group 2" },
];

export const PHASES: { key: Phase; label: string; hint: string }[] = [
  { key: "rampUp", label: "Ramp-up period", hint: "Cycles 1 to 5, then maintaining" },
  { key: "maintaining", label: "Maintaining period", hint: "Straight to the maintaining settings" },
];

export function isGroup(v: unknown): v is Group {
  return v === 1 || v === 2;
}
export function isPhase(v: unknown): v is Phase {
  return v === "rampUp" || v === "maintaining";
}

export interface WorkspaceRotation {
  id: string;
  workspaceId: string;
  workspaceName: string;
  /** The group that sends first. */
  startingGroup: Group;
  /** Where the workspace starts: the ramp-up cycles, or straight into maintaining. */
  phase: Phase;
  createdAt: number;
  updatedAt: number;
}

export interface SetupInput {
  workspaceId: string;
  workspaceName: string;
  startingGroup: Group;
  phase: Phase;
}

/** The problems with a set-up as sent. Empty when it can be saved. */
export function validateSetup(input: Partial<Record<keyof SetupInput, unknown>>): string[] {
  const problems: string[] = [];
  if (typeof input.workspaceId !== "string" || input.workspaceId.trim() === "") problems.push("Pick a workspace.");
  if (!isGroup(input.startingGroup)) problems.push("Pick which sending group starts.");
  if (!isPhase(input.phase)) problems.push("Pick the ramp-up period or the maintaining period.");
  return problems;
}

/** "Sending Group 1 first · ramp-up period" */
export function describeSetup(r: Pick<WorkspaceRotation, "startingGroup" | "phase">): string {
  const phase = PHASES.find((p) => p.key === r.phase)?.label.toLowerCase() ?? r.phase;
  return `Sending Group ${r.startingGroup} first · ${phase}`;
}
