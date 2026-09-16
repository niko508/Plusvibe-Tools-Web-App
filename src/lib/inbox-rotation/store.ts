import "server-only";

import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import {
  DEFAULT_SETTINGS,
  PROFILES,
  cleanProfile,
  isProfileKey,
  normalizeSettings,
  validateProfile,
  validateSetup,
  type Profile,
  type ProfileInput,
  type ProfileKey,
  type RotationSettings,
  type SetupInput,
  type WorkspaceRotation,
} from "./settings";

// Where Inbox Rotation keeps its two files, on the volume next to the other
// tools' jobs: the settings, and the workspaces that have been set up. Both
// are written whole, through a temp file, so a crash mid-write leaves the
// old file rather than half of the new one.

const JOBS_BASE = process.env.JOBS_DIR || path.join(process.cwd(), ".jobs-data");
const DIR = path.join(JOBS_BASE, "inbox-rotation");
const SETTINGS_FILE = path.join(DIR, "settings.json");
const ROTATIONS_FILE = path.join(DIR, "rotations.json");

async function writeWhole(file: string, data: unknown) {
  await fs.mkdir(DIR, { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data), "utf8");
  await fs.rename(tmp, file);
}

// --- Settings -------------------------------------------------------------------

export async function loadSettings(): Promise<RotationSettings> {
  try {
    return normalizeSettings(JSON.parse(await fs.readFile(SETTINGS_FILE, "utf8")) as Partial<RotationSettings>);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export class SettingsProblem extends Error {
  constructor(readonly problems: string[]) {
    super(problems[0] ?? "The settings could not be saved.");
    this.name = "SettingsProblem";
  }
}

/**
 * Replaces the profiles given; the others are kept. Anything that does not
 * validate is refused as a whole — no profile is half-saved.
 */
export async function saveSettings(profiles: Partial<Record<ProfileKey, unknown>>): Promise<RotationSettings> {
  const current = await loadSettings();
  const next = { ...current.profiles };
  const problems: string[] = [];
  let changed = 0;
  for (const [key, raw] of Object.entries(profiles)) {
    if (!isProfileKey(key) || raw === undefined) continue;
    const label = PROFILES.find((p) => p.key === key)?.label ?? key;
    const p = (raw ?? {}) as ProfileInput;
    const ps = validateProfile(p, label);
    if (ps.length > 0) {
      problems.push(...ps);
      continue;
    }
    next[key] = cleanProfile(p as Parameters<typeof cleanProfile>[0]) as Profile;
    changed += 1;
  }
  if (problems.length > 0) throw new SettingsProblem(problems);
  if (changed === 0) throw new SettingsProblem(["Nothing to change."]);
  const saved: RotationSettings = { profiles: next, updatedAt: Date.now() };
  await writeWhole(SETTINGS_FILE, saved);
  return saved;
}

// --- The workspaces set up ----------------------------------------------------------

export async function loadRotations(): Promise<WorkspaceRotation[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(ROTATIONS_FILE, "utf8")) as { rotations?: unknown };
    const list = Array.isArray(parsed.rotations) ? parsed.rotations : [];
    return list.filter(
      (r): r is WorkspaceRotation =>
        !!r && typeof r === "object" && typeof (r as WorkspaceRotation).id === "string" && validateSetup(r as WorkspaceRotation).length === 0
    );
  } catch {
    return [];
  }
}

/**
 * Sets a workspace up, or sets it up again: one workspace has one rotation,
 * so a second set-up for the same workspace replaces the first and keeps its
 * id and creation time.
 */
export async function upsertRotation(input: SetupInput): Promise<WorkspaceRotation> {
  const problems = validateSetup(input);
  if (problems.length > 0) throw new SettingsProblem(problems);
  const list = await loadRotations();
  const now = Date.now();
  const existing = list.find((r) => r.workspaceId === input.workspaceId);
  const rotation: WorkspaceRotation = {
    id: existing?.id ?? randomUUID(),
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    startingGroup: input.startingGroup,
    phase: input.phase,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const next = [...list.filter((r) => r.workspaceId !== input.workspaceId), rotation].sort((a, b) => b.updatedAt - a.updatedAt);
  await writeWhole(ROTATIONS_FILE, { rotations: next });
  return rotation;
}

export async function removeRotation(id: string): Promise<boolean> {
  const list = await loadRotations();
  const next = list.filter((r) => r.id !== id);
  if (next.length === list.length) return false;
  await writeWhole(ROTATIONS_FILE, { rotations: next });
  return true;
}
