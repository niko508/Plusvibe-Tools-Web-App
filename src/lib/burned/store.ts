import "server-only";

import { promises as fs } from "fs";
import path from "path";
import {
  DEFAULT_SETTINGS,
  ESPS,
  isScheduleMode,
  normalizeSchedule,
  normalizeSettings,
  normalizeThresholds,
  validateThresholds,
  type BurnedSettings,
  type Esp,
} from "./settings";

// Where Find Burned Domains & Inboxes keeps the thresholds, on the volume
// next to the other tools' jobs. One file, written whole through a temp file,
// so a crash mid-write leaves the old file rather than half of the new one.

const JOBS_BASE = process.env.JOBS_DIR || path.join(process.cwd(), ".jobs-data");
const DIR = path.join(JOBS_BASE, "burned");
const SETTINGS_FILE = path.join(DIR, "settings.json");

export async function loadSettings(): Promise<BurnedSettings> {
  try {
    return normalizeSettings(JSON.parse(await fs.readFile(SETTINGS_FILE, "utf8")) as Partial<BurnedSettings>);
  } catch {
    return normalizeSettings(DEFAULT_SETTINGS);
  }
}

export class SettingsProblem extends Error {
  constructor(readonly problems: string[]) {
    super(problems[0] ?? "The thresholds could not be saved.");
    this.name = "SettingsProblem";
  }
}

/**
 * Saves one or both providers' thresholds, the weekly schedule, or any mix;
 * whatever is left out keeps what it had, so editing Google never disturbs
 * Microsoft and switching the schedule on never touches either.
 */
export async function saveSettings(raw: Record<string, unknown>): Promise<BurnedSettings> {
  const current = await loadSettings();
  const problems: string[] = [];
  const next = { ...current.thresholds };

  for (const esp of ESPS) {
    const given = raw[esp];
    if (given === undefined) continue;
    if (!given || typeof given !== "object") {
      problems.push(`${esp}: send the thresholds to save.`);
      continue;
    }
    const found = validateThresholds(given as Record<string, unknown>);
    if (found.length > 0) problems.push(...found.map((p) => `${esp === "google" ? "Google" : "Microsoft"} — ${p}`));
    else next[esp] = normalizeThresholds(given, esp);
  }
  let schedule = current.schedule;
  if (raw.schedule !== undefined) {
    const given = (raw.schedule ?? {}) as Record<string, unknown>;
    if (typeof given !== "object") problems.push("Schedule: send it as an object.");
    else if (given.mode !== undefined && !isScheduleMode(given.mode)) problems.push("Schedule: pick Report only or Remove.");
    else if (given.enabled !== undefined && typeof given.enabled !== "boolean") problems.push("Schedule: on or off.");
    else schedule = normalizeSchedule({ ...current.schedule, ...given });
  }

  if (problems.length > 0) throw new SettingsProblem(problems);
  if (!ESPS.some((e) => raw[e] !== undefined) && raw.schedule === undefined) {
    throw new SettingsProblem(["Send at least one provider's thresholds, or the schedule."]);
  }

  const settings: BurnedSettings = { thresholds: next, schedule, updatedAt: Date.now() };
  await fs.mkdir(DIR, { recursive: true });
  const tmp = `${SETTINGS_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(settings), "utf8");
  await fs.rename(tmp, SETTINGS_FILE);
  return settings;
}

export async function thresholdsFor(esp: Esp) {
  return (await loadSettings()).thresholds[esp];
}

export async function scheduleSettings() {
  return (await loadSettings()).schedule;
}
