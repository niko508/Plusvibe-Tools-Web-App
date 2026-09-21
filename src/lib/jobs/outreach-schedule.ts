import "server-only";

import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { plusvibeGet, plusvibePut } from "@/lib/plusvibe-server";
import { acquireSlot } from "@/lib/jobs/rate-limit";
import { CATEGORY_LABELS, type Category } from "@/lib/start-outreach/categories";
import { normalizeEmail } from "@/lib/start-outreach/readiness";
import { parseOutreachSettings, type OutreachSettingsInput } from "@/lib/start-outreach/plan";
import { week2DueAt } from "@/lib/start-outreach/schedule";
import { CHUNK } from "@/lib/jobs/start-outreach-types";
import type { ScheduledSwitch, SwitchCategory } from "@/lib/jobs/outreach-schedule-types";
import { MAX_STORED_ERRORS } from "@/lib/jobs/outreach-schedule-types";

// The scheduled week 2 switch.
//
// A batch is started on its category's week 1 numbers and left alone for a
// week; this is what moves it onto week 2, at six in the morning Helsinki time
// so the change is in place before any sending window opens.
//
// It runs with NOBODY WATCHING, which decides most of the design:
//
//   - the whole thing lives on the volume, not in a browser, and the scheduler
//     is started from instrumentation.ts at boot, so a Railway deploy in the
//     middle of the week does not lose a switch
//   - it uses the server's own API key, because there is no request to take one
//     from at six in the morning
//   - it stores ADDRESSES and resolves them to ids on the day: a week is long
//     enough for an inbox to be deleted and its id handed to another, and
//     changing the settings of the wrong mailbox is not a recoverable mistake
//   - a switch that has already run is never run again, however often the
//     process restarts
//
// Reading the file back is cheap and there will only ever be a handful of
// pending switches, so the whole set is kept in memory and rewritten on change.

const JOBS_BASE = process.env.JOBS_DIR || path.join(process.cwd(), ".jobs-data");
const DIR = path.join(JOBS_BASE, "start-outreach");
const FILE = path.join(DIR, "scheduled.json");
/** How often the due check runs. A minute is plenty for an hourly-ish event. */
const TICK_MS = 60_000;
/** Finished switches are kept this long so the list still shows what happened. */
const KEEP_FINISHED_MS = 30 * 86_400_000;

let cache: ScheduledSwitch[] | null = null;

export function serverApiKey(): string | null {
  const key = process.env.PLUSVIBE_API_KEY?.trim();
  return key ? key : null;
}

// --- Persistence -----------------------------------------------------------

async function load(): Promise<ScheduledSwitch[]> {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(await fs.readFile(FILE, "utf8")) as ScheduledSwitch[];
    cache = Array.isArray(parsed)
      ? parsed.map((s) => ({
          ...s,
          categories: Array.isArray(s.categories) ? s.categories : [],
          errors: Array.isArray(s.errors) ? s.errors : [],
          // A switch the process died in the middle of is put back in the
          // queue rather than left reading "running" forever.
          status: s.status === "running" ? "scheduled" : s.status,
        }))
      : [];
  } catch {
    cache = [];
  }
  return cache;
}

async function save() {
  if (!cache) return;
  try {
    await fs.mkdir(DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(cache), "utf8");
    await fs.rename(tmp, FILE);
  } catch {
    // best-effort; a failed write must not stop a switch from being applied
  }
}

// --- Creating one ----------------------------------------------------------

export interface ScheduleInput {
  jobId: string;
  workspaceId: string;
  workspaceName: string;
  categories: { category: Category; emails: string[]; settings: OutreachSettingsInput }[];
  /** The clock, so a test can place the switch exactly. */
  now?: number;
}

/**
 * Books a batch's week 2 switch.
 *
 * Categories with no inboxes are left out; a category whose week 2 is entirely
 * blank is left out too, because a scheduled task that wakes up and changes
 * nothing is worse than no task — it reads as done when nothing was done.
 * Returns null when that leaves nothing to schedule.
 */
export async function schedule(input: ScheduleInput): Promise<ScheduledSwitch | null> {
  const all = await load();
  const now = input.now ?? Date.now();

  const categories: SwitchCategory[] = [];
  for (const c of input.categories) {
    const emails = Array.from(new Set(c.emails.map(normalizeEmail).filter(Boolean)));
    if (emails.length === 0) continue;
    const parsed = parseOutreachSettings(c.settings);
    // `body` always carries the two ramp-up switches, so "changes nothing"
    // means no field of its own was filled in.
    if (parsed.summary.every((r) => r.key.endsWith("RampUp"))) continue;
    categories.push({ category: c.category, emails, settings: c.settings });
  }
  if (categories.length === 0) return null;

  const rec: ScheduledSwitch = {
    id: randomUUID(),
    status: "scheduled",
    createdAt: now,
    dueAt: week2DueAt(now),
    jobId: input.jobId,
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    categories,
    totalInboxes: categories.reduce((n, c) => n + c.emails.length, 0),
    errors: [],
  };
  all.push(rec);
  await save();
  return rec;
}

// --- Reading and controlling ------------------------------------------------

export async function listSwitches(): Promise<ScheduledSwitch[]> {
  const all = await load();
  return [...all].sort((a, b) => a.dueAt - b.dueAt || a.createdAt - b.createdAt);
}

export async function cancelSwitch(id: string): Promise<boolean> {
  const all = await load();
  const rec = all.find((s) => s.id === id);
  if (!rec || rec.status !== "scheduled") return false;
  rec.status = "cancelled";
  await save();
  return true;
}

export async function deleteSwitch(id: string): Promise<boolean> {
  const all = await load();
  const at = all.findIndex((s) => s.id === id);
  if (at === -1) return false;
  if (all[at].status === "running") return false;
  all.splice(at, 1);
  await save();
  return true;
}

/** Applies a switch now rather than waiting for its morning. */
export async function runNow(id: string, apiKey: string): Promise<boolean> {
  const all = await load();
  const rec = all.find((s) => s.id === id);
  if (!rec || rec.status !== "scheduled") return false;
  await apply(rec, apiKey);
  return true;
}

// --- Applying ---------------------------------------------------------------

function msg(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

function pushError(rec: ScheduledSwitch, text: string) {
  if (rec.errors.length < MAX_STORED_ERRORS) rec.errors.push(text);
}

/** Every inbox in the workspace, as address → id. Paged, through the limiter. */
async function idsByEmail(apiKey: string, workspaceId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const PAGE = 100;
  for (let page = 0; page < 200; page++) {
    await acquireSlot();
    const data = await plusvibeGet<unknown>({
      apiKey,
      path: "/account/list",
      query: { workspace_id: workspaceId, skip: String(page * PAGE), limit: String(PAGE) },
    });
    const raw = Array.isArray(data)
      ? (data as Array<Record<string, unknown>>)
      : Array.isArray((data as { accounts?: unknown })?.accounts)
        ? (data as { accounts: Array<Record<string, unknown>> }).accounts
        : [];
    for (const a of raw) {
      const id = String(a.id ?? a._id ?? "").trim();
      const email = normalizeEmail(String(a.email ?? ""));
      if (id && email && !out.has(email)) out.set(email, id);
    }
    if (raw.length < PAGE) break;
  }
  return out;
}

const chunk = <T,>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

/**
 * Moves one batch onto its week 2 numbers, a category at a time.
 *
 * An address that is no longer in the workspace is counted and reported, not
 * treated as a failure: an inbox deleted during the week is a normal thing to
 * have happened, and the rest of the batch still has to be switched.
 */
export async function apply(rec: ScheduledSwitch, apiKey: string): Promise<void> {
  rec.status = "running";
  rec.ranAt = Date.now();
  await save();

  let found: Map<string, string>;
  try {
    found = await idsByEmail(apiKey, rec.workspaceId);
  } catch (err) {
    rec.status = "error";
    pushError(rec, `Could not read ${rec.workspaceName}'s inboxes, so nothing was switched: ${msg(err)}`);
    await save();
    return;
  }

  for (const c of rec.categories) {
    const ids: string[] = [];
    let missing = 0;
    for (const email of c.emails) {
      const id = found.get(email);
      if (id) ids.push(id);
      else missing += 1;
    }
    c.updated = 0;
    c.notFound = missing;
    if (missing > 0) {
      pushError(
        rec,
        `${CATEGORY_LABELS[c.category]}: ${missing} of ${c.emails.length} are no longer in ${rec.workspaceName} and were left alone.`
      );
    }
    if (ids.length === 0) continue;

    const body = parseOutreachSettings(c.settings).body;
    for (const part of chunk(ids, CHUNK)) {
      try {
        await acquireSlot();
        await plusvibePut({
          apiKey,
          path: "/account/bulk-update",
          body: { workspace_id: rec.workspaceId, ids: part, ...body },
        });
        c.updated += part.length;
      } catch (err) {
        pushError(rec, `${CATEGORY_LABELS[c.category]}: ${part.length} were not updated (${msg(err)}).`);
      }
      await save();
    }
  }

  const switched = rec.categories.reduce((n, c) => n + (c.updated ?? 0), 0);
  rec.status = switched === rec.totalInboxes && rec.errors.length === 0 ? "done" : "error";
  await save();
}

// --- The scheduler ----------------------------------------------------------

let started = false;

async function tick() {
  const all = await load();
  const now = Date.now();

  // Drop finished switches that are old enough that nobody is still reading
  // them, so the file cannot grow without end.
  const before = all.length;
  for (let i = all.length - 1; i >= 0; i--) {
    const s = all[i];
    if (s.status === "scheduled" || s.status === "running") continue;
    const at = s.ranAt ?? s.createdAt;
    if (now - at > KEEP_FINISHED_MS) all.splice(i, 1);
  }
  if (all.length !== before) await save();

  const due = all.filter((s) => s.status === "scheduled" && s.dueAt <= now);
  if (due.length === 0) return;
  const apiKey = serverApiKey();
  if (!apiKey) {
    // Said once per due switch rather than every minute.
    for (const s of due) {
      s.status = "error";
      pushError(s, "No server API key is configured (PLUSVIBE_API_KEY), so the week 2 switch could not run.");
    }
    await save();
    return;
  }
  for (const s of due) {
    try {
      await apply(s, apiKey);
    } catch (err) {
      s.status = "error";
      pushError(s, msg(err));
      await save();
    }
  }
}

/** Starts the due check. Idempotent — instrumentation.ts calls it at boot. */
export function bootScheduler() {
  if (started) return;
  started = true;
  const timer = setInterval(() => void tick(), TICK_MS);
  // Never keep the process alive just for this.
  timer.unref?.();
  // A switch that came due while the process was down should not wait a
  // further minute: on Railway the process is replaced on every deploy.
  void tick();
}
