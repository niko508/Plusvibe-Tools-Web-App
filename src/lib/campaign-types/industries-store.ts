import "server-only";

import { promises as fs } from "fs";
import path from "path";
import { normalizeIndustries, removeIndustry, saveIndustry, type Industry } from "./industries";

// The saved industries, on the volume: one list for everyone using the app,
// like General Settings, so a teammate's saved segments show up for you too.

const JOBS_BASE = process.env.JOBS_DIR || path.join(process.cwd(), ".jobs-data");
const STORE_DIR = path.join(JOBS_BASE, "industries");
const FILE = path.join(STORE_DIR, "industries.json");

// Saves one after another, so two at once can't drop each other's change.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

export async function loadIndustries(): Promise<Industry[]> {
  try {
    return normalizeIndustries(JSON.parse(await fs.readFile(FILE, "utf8")).industries);
  } catch {
    return [];
  }
}

async function write(list: Industry[]): Promise<void> {
  await fs.mkdir(STORE_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ industries: list }), "utf8");
  await fs.rename(tmp, FILE);
}

export class IndustryError extends Error {}

export function upsertIndustry(input: { name: string; segments: string[]; noSegment?: string | null }): Promise<{ industries: Industry[]; saved: Industry }> {
  return serial(async () => {
    const r = saveIndustry(await loadIndustries(), input, Date.now());
    if (!r.saved) throw new IndustryError(r.problem ?? "Could not save the industry.");
    await write(r.list);
    return { industries: r.list, saved: r.saved };
  });
}

export function deleteIndustry(name: string): Promise<Industry[]> {
  return serial(async () => {
    const list = removeIndustry(await loadIndustries(), name);
    await write(list);
    return list;
  });
}
