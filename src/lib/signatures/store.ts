import "server-only";

import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";

// Remembers the signature inputs per workspace, so adding signatures to a
// workspace's new inboxes doesn't mean retyping the titles, company names,
// phones and addresses that were used last time.
//
// Kept server-side rather than in localStorage: these are per-client details
// worth real effort to assemble, and browser storage loses them on a cleared
// cache and never follows you to another machine. Scoped by API-key
// fingerprint like the job stores, so one key never sees another's presets.
// The key itself is never written to disk.

const JOBS_BASE = process.env.JOBS_DIR || path.join(process.cwd(), ".jobs-data");
const STORE_DIR = path.join(JOBS_BASE, "signature-presets");

/** Guards against a runaway payload filling the volume. */
export const MAX_VALUES_PER_FIELD = 20;
export const MAX_VALUE_CHARS = 200;

export interface SignaturePreset {
  titles: string[];
  companies: string[];
  phones: string[];
  addresses: string[];
  /** When it was last saved, for "remembered from …" in the UI. */
  savedAt: number;
}

function fingerprintKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

/**
 * One file per API key, presets keyed by workspace inside it.
 *
 * A workspace id is opaque and could contain anything, so it is never used as a
 * path segment — that would let a crafted id escape the directory.
 */
function fileFor(apiKey: string): string {
  return path.join(STORE_DIR, `${fingerprintKey(apiKey)}.json`);
}

type PresetFile = Record<string, SignaturePreset>;

async function readFile(apiKey: string): Promise<PresetFile> {
  try {
    const raw = await fs.readFile(fileFor(apiKey), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as PresetFile;
  } catch {
    // Missing or corrupt: an empty set of presets is the right fallback — the
    // form simply starts blank, and the next save overwrites cleanly.
    return {};
  }
}

function cleanValues(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((v) => String(v ?? "").trim())
    .filter(Boolean)
    .slice(0, MAX_VALUES_PER_FIELD)
    .map((v) => v.slice(0, MAX_VALUE_CHARS));
}

/** Reads one workspace's preset, or null if nothing has been saved for it. */
export async function loadPreset(
  apiKey: string,
  workspaceId: string
): Promise<SignaturePreset | null> {
  const all = await readFile(apiKey);
  const found = all[workspaceId];
  if (!found) return null;
  const preset: SignaturePreset = {
    titles: cleanValues(found.titles),
    companies: cleanValues(found.companies),
    phones: cleanValues(found.phones),
    addresses: cleanValues(found.addresses),
    savedAt: typeof found.savedAt === "number" ? found.savedAt : 0,
  };
  // A preset with nothing in it is the same as no preset.
  const empty =
    preset.titles.length === 0 &&
    preset.companies.length === 0 &&
    preset.phones.length === 0 &&
    preset.addresses.length === 0;
  return empty ? null : preset;
}

export async function savePreset(
  apiKey: string,
  workspaceId: string,
  preset: Omit<SignaturePreset, "savedAt">
): Promise<SignaturePreset> {
  const all = await readFile(apiKey);
  const clean: SignaturePreset = {
    titles: cleanValues(preset.titles),
    companies: cleanValues(preset.companies),
    phones: cleanValues(preset.phones),
    addresses: cleanValues(preset.addresses),
    savedAt: Date.now(),
  };
  all[workspaceId] = clean;

  await fs.mkdir(STORE_DIR, { recursive: true });
  // Write to a temp file and rename, so an interrupted write can't leave the
  // file truncated and take every OTHER workspace's preset with it.
  const target = fileFor(apiKey);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(all), "utf8");
  await fs.rename(tmp, target);
  return clean;
}

export async function deletePreset(
  apiKey: string,
  workspaceId: string
): Promise<boolean> {
  const all = await readFile(apiKey);
  if (!all[workspaceId]) return false;
  delete all[workspaceId];
  await fs.mkdir(STORE_DIR, { recursive: true });
  const target = fileFor(apiKey);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(all), "utf8");
  await fs.rename(tmp, target);
  return true;
}
