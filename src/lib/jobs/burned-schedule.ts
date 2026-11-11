import "server-only";

import { promises as fs } from "fs";
import path from "path";
import { isSheetWritingConfigured } from "@/lib/google-sheets";
import { ESPS, type Esp } from "@/lib/burned/settings";
import { loadSettings } from "@/lib/burned/store";
import { dueThisWeek, isDue, nextRunAt, removalGuard, weekOf, windowFor } from "@/lib/burned/schedule";
import { createJob as createScan, waitFor as waitForScan } from "@/lib/jobs/burned";
import { createJob as createRemoval, waitFor as waitForRemoval } from "@/lib/jobs/burned-removal";
import type { WeeklyRun, WeeklyState, WeeklyStatus, WeeklyStep } from "@/lib/jobs/burned-schedule-types";

// The weekly Find Burned run.
//
// Monday at six, Helsinki time, with nobody watching: scan Microsoft domains
// and Google inboxes across every workspace over the last 30 days, then — in
// remove mode only — record each scan's burned rows in the sheet and delete
// their inboxes, the same removal the Remove button runs.
//
// What that decides:
//
//   - it uses the server's own key (PLUSVIBE_API_KEY), because there is no
//     request to take one from at six in the morning
//   - the week is marked as run the moment the run STARTS, so a crash or a
//     deploy mid-run never repeats deletions; the run is shown as interrupted
//     instead, and "Run now" is there to finish the job by hand
//   - a scan that did not finish cleanly is never acted on, and neither is
//     one that burned an implausible share of what it judged (removalGuard)
//
// The state is one small file on the volume, rewritten whole on change.

const JOBS_BASE = process.env.JOBS_DIR || path.join(process.cwd(), ".jobs-data");
// Its own folder: the scans' folder is read as scan records, file by file.
const DIR = path.join(JOBS_BASE, "burned-schedule");
const FILE = path.join(DIR, "state.json");
const TICK_MS = Number(process.env.BURNED_SCHEDULE_TICK_MS ?? "") || 10 * 60 * 1000;
const MAX_ERRORS = 50;

// On globalThis: instrumentation.ts runs the scheduler and the route handlers
// read the state, and they load this module separately.
interface Shared {
  state: WeeklyState | null;
  started: boolean;
  running: boolean;
}
const shared: Shared = ((globalThis as { __pvBurnedSchedule?: Shared }).__pvBurnedSchedule ??= {
  state: null,
  started: false,
  running: false,
});

export function serverApiKey(): string | null {
  return process.env.PLUSVIBE_API_KEY?.trim() || null;
}

async function load(): Promise<WeeklyState> {
  if (shared.state) return shared.state;
  try {
    const parsed = JSON.parse(await fs.readFile(FILE, "utf8")) as WeeklyState;
    shared.state = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    shared.state = {};
  }
  const last = shared.state.lastRun;
  if (last) {
    last.steps = Array.isArray(last.steps) ? last.steps : [];
    last.errors = Array.isArray(last.errors) ? last.errors : [];
    // A run the process died in the middle of is never picked up again by
    // itself: it may have been deleting.
    if (last.status === "running" && !shared.running) {
      last.status = "interrupted";
      last.finishedAt = last.finishedAt ?? Date.now();
    }
  }
  return shared.state;
}

async function save() {
  if (!shared.state) return;
  try {
    await fs.mkdir(DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(shared.state), "utf8");
    await fs.rename(tmp, FILE);
  } catch {
    // best-effort; a failed write must not stop the run
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

function pushError(run: WeeklyRun, text: string) {
  if (run.errors.length < MAX_ERRORS) run.errors.push(text);
}

export async function status(now = Date.now()): Promise<WeeklyStatus> {
  const state = await load();
  const { schedule } = await loadSettings();
  return {
    schedule,
    state,
    nextRunAt: schedule.enabled ? nextRunAt(now, state.lastWeek) : null,
    serverKey: serverApiKey() !== null,
    sheetWriting: isSheetWritingConfigured(),
    running: shared.running,
  };
}

export class WeeklyBusy extends Error {
  constructor() {
    super("The weekly run is already going — let it finish first.");
    this.name = "WeeklyBusy";
  }
}

/** One provider: scan, then (in remove mode) remove what it found burned. */
async function runStep(apiKey: string, run: WeeklyRun, esp: Esp, sheetUrl: string) {
  const step: WeeklyStep = { esp };
  run.steps.push(step);
  await save();

  let scanId: string;
  try {
    scanId = await createScan(apiKey, { esp, start: run.start, end: run.end }, { scheduled: true });
  } catch (err) {
    step.note = `The scan could not start: ${msg(err)}`;
    pushError(run, `${esp}: ${step.note}`);
    return;
  }
  step.scanJobId = scanId;
  await save();

  const scan = await waitForScan(scanId);
  step.scanStatus = scan?.status ?? "missing";
  const rows = scan?.rows ?? [];
  step.burned = rows.filter((r) => r.verdict === "burned").length;
  step.judged = rows.filter((r) => r.verdict !== "quiet").length;
  step.scanned = rows.length;
  await save();

  if (run.mode !== "remove") return;
  if (!scan || scan.status !== "done") {
    step.note = "The scan did not finish cleanly, so nothing was removed.";
    return;
  }
  if (step.burned === 0) return;
  const guard = removalGuard(step.burned, step.judged);
  if (guard) {
    step.note = guard;
    pushError(run, `${esp}: ${guard}`);
    return;
  }

  let removalId: string;
  try {
    removalId = await createRemoval(apiKey, { scanJobId: scanId, sheetUrl: sheetUrl || undefined }, { scheduled: true });
  } catch (err) {
    step.note = `Nothing was removed: ${msg(err)}`;
    pushError(run, `${esp}: ${step.note}`);
    return;
  }
  step.removalJobId = removalId;
  await save();
  const removal = await waitForRemoval(removalId);
  step.removalStatus = removal?.status ?? "missing";
  step.inboxesDeleted = removal?.progress.inboxesDeleted ?? 0;
}

/**
 * Runs the weekly check now.
 *
 * The scheduler calls it on Monday morning; "Run now" calls it any time, in
 * whichever mode is saved. Resolves when the whole run has finished.
 */
export async function runWeekly(trigger: "scheduled" | "manual", now = Date.now()): Promise<WeeklyRun> {
  if (shared.running) throw new WeeklyBusy();
  const apiKey = serverApiKey();
  if (!apiKey) throw new Error("PLUSVIBE_API_KEY is not set on the server, so the weekly run has no key to work with.");

  shared.running = true;
  try {
    const state = await load();
    const { schedule } = await loadSettings();
    const week = weekOf(now);
    const range = windowFor(now);
    const run: WeeklyRun = {
      week,
      trigger,
      mode: schedule.mode,
      status: "running",
      startedAt: Date.now(),
      start: range.start,
      end: range.end,
      steps: [],
      errors: [],
    };
    // Marked as run before anything happens: never twice in one week.
    if (trigger === "scheduled") state.lastWeek = week;
    state.lastRun = run;
    await save();

    try {
      // Microsoft first: a domain is a tenant being paid for.
      for (const esp of ["microsoft", "google"] as Esp[]) {
        if (!ESPS.includes(esp)) continue;
        await runStep(apiKey, run, esp, schedule.sheetUrl);
      }
      const bad = run.steps.some(
        (s) =>
          !s.scanJobId ||
          (s.scanStatus && s.scanStatus !== "done") ||
          (s.removalStatus && s.removalStatus !== "done") ||
          (run.mode === "remove" && s.note && (s.burned ?? 0) > 0)
      );
      run.status = bad ? "error" : "done";
    } catch (err) {
      pushError(run, msg(err));
      run.status = "error";
    } finally {
      run.finishedAt = Date.now();
      await save();
    }
    return run;
  } finally {
    shared.running = false;
  }
}

/**
 * Called when the schedule is switched on. Past this week's time, the week
 * counts as done, so the first run is next Monday — switching it on midweek
 * must not start deleting there and then. "Run now" is there for that.
 */
export async function switchedOn(now = Date.now()) {
  const state = await load();
  if (now >= dueThisWeek(now)) {
    state.lastWeek = weekOf(now);
    await save();
  }
}

async function tick() {
  if (shared.running) return;
  try {
    const { schedule } = await loadSettings();
    if (!schedule.enabled || !serverApiKey()) return;
    const state = await load();
    if (!isDue(Date.now(), state.lastWeek)) return;
    await runWeekly("scheduled");
  } catch {
    // the next tick tries again; the run itself records what went wrong
  }
}

export async function bootScheduler() {
  if (shared.started) return;
  shared.started = true;
  await load();
  await save();
  const timer = setInterval(() => void tick(), TICK_MS);
  // Never keep the process alive just for this.
  timer.unref?.();
  // A run that came due while the process was down should not wait a tick.
  void tick();
}
