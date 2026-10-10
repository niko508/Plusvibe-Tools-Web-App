import "server-only";

import { promises as fs } from "fs";
import path from "path";
import { normalizeWarmupSettings, type WarmupSettings } from "@/lib/azure-warmup/warmup-settings";

// Where the Azure Start Warmup settings live: on the volume, next to the runs,
// because a run reads them on the server when it starts — no browser involved.
//
// Kept in a folder of their own: the runs' folder is read as "every .json is a
// run", and a settings file in there would be taken for one.

const JOBS_BASE = process.env.JOBS_DIR || path.join(process.cwd(), ".jobs-data");
const STORE_DIR = path.join(JOBS_BASE, "azure-warmup-settings");
const FILE = path.join(STORE_DIR, "settings.json");

export interface StoredWarmupSettings {
  settings: WarmupSettings;
  /** 0 until someone saves; the defaults are in use until then. */
  updatedAt: number;
}

export async function loadWarmupSettings(): Promise<StoredWarmupSettings> {
  try {
    const parsed = JSON.parse(await fs.readFile(FILE, "utf8")) as { settings?: unknown; updatedAt?: unknown };
    return {
      settings: normalizeWarmupSettings(parsed.settings),
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
    };
  } catch {
    return { settings: normalizeWarmupSettings(undefined), updatedAt: 0 };
  }
}

export async function saveWarmupSettings(settings: WarmupSettings): Promise<StoredWarmupSettings> {
  const stored = { settings, updatedAt: Date.now() };
  await fs.mkdir(STORE_DIR, { recursive: true });
  // Written whole and renamed into place, so a crash mid-write never leaves a
  // half file for the next run to read.
  const tmp = `${FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(stored), "utf8");
  await fs.rename(tmp, FILE);
  return stored;
}
