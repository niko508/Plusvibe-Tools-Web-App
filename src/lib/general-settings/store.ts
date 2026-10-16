import "server-only";

import { promises as fs } from "fs";
import path from "path";
import {
  generalSettings,
  generalSettingsState,
  normalizeGeneralSettings,
  setGeneralSettings,
  withRetiredOptOut,
  type GeneralSettings,
} from "./settings";

// General Settings on the volume. One file for the whole app, like the Blocked
// Domains settings: the webhook and the schedulers read these values at 3am
// with no browser involved, so they can't live in localStorage.
//
// Loaded at boot (instrumentation.ts) and put in force for every module that
// reads generalSettings(); a save writes the file and puts the new copy in
// force at once.

const JOBS_BASE = process.env.JOBS_DIR || path.join(process.cwd(), ".jobs-data");
const STORE_DIR = path.join(JOBS_BASE, "general-settings");
const FILE = path.join(STORE_DIR, "settings.json");

let loading: Promise<void> | null = null;

/** Reads the file and puts it in force. A missing or unreadable file means the defaults. */
export async function loadGeneralSettings(): Promise<void> {
  try {
    const raw = JSON.parse(await fs.readFile(FILE, "utf8")) as { settings?: unknown; updatedAt?: unknown };
    setGeneralSettings(normalizeGeneralSettings(raw.settings), typeof raw.updatedAt === "number" ? raw.updatedAt : 0);
  } catch {
    setGeneralSettings(normalizeGeneralSettings(undefined), 0);
  }
}

/** The settings in force, loading them first if this process hasn't yet. */
export async function currentGeneralSettings(): Promise<{ settings: GeneralSettings; updatedAt: number }> {
  if (!generalSettingsState().loaded) {
    loading ??= loadGeneralSettings().finally(() => {
      loading = null;
    });
    await loading;
  }
  return { settings: generalSettings(), updatedAt: generalSettingsState().updatedAt };
}

/** Writes validated settings and puts them in force. */
export async function saveGeneralSettings(next: GeneralSettings): Promise<{ settings: GeneralSettings; updatedAt: number }> {
  const { settings: prev } = await currentGeneralSettings();
  const settings = withRetiredOptOut(prev, next);
  const updatedAt = Date.now();
  await fs.mkdir(STORE_DIR, { recursive: true });
  // Temp file and rename: an interrupted write can't leave half a file.
  const tmp = `${FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ settings, updatedAt }), "utf8");
  await fs.rename(tmp, FILE);
  setGeneralSettings(settings, updatedAt);
  return { settings, updatedAt };
}
