import "server-only";

import { promises as fs } from "fs";
import path from "path";
import {
  DEFAULT_SETTINGS,
  isDominant,
  normalizeSettings,
  parseLimit,
  type CampaignTypesSettings,
} from "./settings";

// Where the Create All Campaign Types settings live: next to the tool's jobs,
// on the volume, so they are the same from every browser and survive a
// redeploy. Read once per run when the job is queued.

const JOBS_BASE = process.env.JOBS_DIR || path.join(process.cwd(), ".jobs-data");
const STORE_DIR = path.join(JOBS_BASE, "campaign-types");
const FILE = path.join(STORE_DIR, "settings.json");

export async function loadSettings(): Promise<CampaignTypesSettings> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    return normalizeSettings(JSON.parse(raw) as Partial<CampaignTypesSettings>);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export type SettingsPatch = Partial<Pick<CampaignTypesSettings, "dominant" | "googleDailyLimit" | "microsoftDailyLimit">>;

/** Changes only the fields given; a limit given as null is cleared. */
export async function saveSettings(patch: SettingsPatch): Promise<CampaignTypesSettings> {
  const current = await loadSettings();
  const next: CampaignTypesSettings = {
    dominant: isDominant(patch.dominant) ? patch.dominant : current.dominant,
    googleDailyLimit:
      patch.googleDailyLimit === undefined ? current.googleDailyLimit : parseLimit(patch.googleDailyLimit, "").value,
    microsoftDailyLimit:
      patch.microsoftDailyLimit === undefined
        ? current.microsoftDailyLimit
        : parseLimit(patch.microsoftDailyLimit, "").value,
    updatedAt: Date.now(),
  };
  await fs.mkdir(STORE_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next), "utf8");
  await fs.rename(tmp, FILE);
  return next;
}
