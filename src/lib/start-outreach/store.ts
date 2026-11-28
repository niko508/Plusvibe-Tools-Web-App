import "server-only";

import { promises as fs } from "fs";
import path from "path";
import {
  DEFAULT_OUTREACH_SETTINGS,
  normalizeSettings,
  validateSettings,
  type OutreachSettings,
} from "./week-settings";

// Where Start Outreach keeps its per-category week 1 / week 2 settings, on the
// volume beside the other tools' jobs. One file, written whole through a temp
// file, so a crash mid-write leaves the old file rather than half the new one.
//
// These are read by the scheduler as well as the form, and the scheduler runs
// with nobody watching — so they live on the server, not in a browser.

const JOBS_BASE = process.env.JOBS_DIR || path.join(process.cwd(), ".jobs-data");
const DIR = path.join(JOBS_BASE, "start-outreach");
const SETTINGS_FILE = path.join(DIR, "settings.json");

export async function loadSettings(): Promise<OutreachSettings> {
  try {
    return normalizeSettings(JSON.parse(await fs.readFile(SETTINGS_FILE, "utf8")));
  } catch {
    return normalizeSettings(DEFAULT_OUTREACH_SETTINGS);
  }
}

export class SettingsProblem extends Error {
  constructor(readonly problems: string[]) {
    super(problems[0] ?? "The settings could not be saved.");
    this.name = "SettingsProblem";
  }
}

/**
 * Saves a whole set.
 *
 * Validated with the same parser the run applies, so a number that would be
 * refused when it reaches Plusvibe is refused here — not a week later at six
 * in the morning with nobody watching.
 */
export async function saveSettings(raw: unknown): Promise<OutreachSettings> {
  const next = normalizeSettings(raw);
  const problems = validateSettings(next);
  if (problems.length > 0) throw new SettingsProblem(problems);
  await fs.mkdir(DIR, { recursive: true });
  const tmp = `${SETTINGS_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next), "utf8");
  await fs.rename(tmp, SETTINGS_FILE);
  return next;
}
