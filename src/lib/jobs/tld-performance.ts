import "server-only";

import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { fetchInboxStats, listInboxes, listWorkspaces } from "@/lib/blocked-domains/api";
import { bucketOf } from "@/lib/plusvibe-providers";
import { listTags } from "@/lib/plusvibe-tags";
import { acquireSlot } from "@/lib/jobs/rate-limit";
import { ensureTab, isSheetWritingConfigured, readTab, replaceTabValues, envSpreadsheetId } from "@/lib/google-sheets";
import { extractSheetId, fetchSheetGrid } from "@/lib/sheet";
import { domainsTab, generalSettings } from "@/lib/general-settings/settings";
import { findPlatformTag } from "@/lib/tags/domain-tags";
import { listJobs as listDomainJobs } from "@/lib/jobs/blocked-domains";
import { listInboxDomains, listInboxJobs } from "@/lib/jobs/blocked-inboxes";
import { statsEntries } from "@/lib/blocked-inboxes/domains";
import { describeDue } from "@/lib/start-outreach/schedule";
import { instantAt } from "@/lib/start-outreach/schedule";
import {
  buildReport,
  domainOfEmail,
  sheetGrid,
  UNKNOWN_PLATFORM,
  type BlockedDomain,
  type InboxFigures,
  type ProviderBucket,
} from "@/lib/tld-performance/report";
import {
  DEFAULT_TLD_SETTINGS,
  isDue,
  lastFullMonth,
  monthRange,
  nextRunAt,
  normalizeTldSettings,
  validateTldPatch,
  type TldSettings,
} from "@/lib/tld-performance/schedule";
import type { TldReport, TldReportSummary, TldStatus } from "@/lib/jobs/tld-performance-types";

// TLD Performance Tracking, on the server.
//
// A report is one month: every workspace's inboxes and their figures for it,
// grouped by domain, tagged with the domain's registrar from 📋 Domains, and
// joined with the domains the Blocked Domains automation caught that month.
// It reads only — nothing in Plusvibe changes — and, when a sheet is set,
// writes the result to one tab of it.
//
// Two ways in: "Run" on the page with the browser's key, and the monthly run
// on the 1st at 06:00 Helsinki with the server's key (PLUSVIBE_API_KEY). One
// report per month: running a month again replaces it.
//
// The reports are small files on the volume. State lives on globalThis, as
// the scheduler (instrumentation.ts) and the route handlers load this module
// separately.

const JOBS_BASE = process.env.JOBS_DIR || path.join(process.cwd(), ".jobs-data");
const DIR = path.join(JOBS_BASE, "tld-performance");
const SETTINGS_FILE = path.join(DIR, "settings.json");
const STATE_FILE = path.join(DIR, "state.json");
const TICK_MS = Number(process.env.TLD_SCHEDULE_TICK_MS ?? "") || 30 * 60 * 1000;
const MAX_ERRORS = 50;

interface Shared {
  reports: Map<string, TldReport> | null;
  settings: TldSettings | null;
  /** The last month the scheduled run made, so it never runs twice for one. */
  lastScheduledMonth?: string;
  stateLoaded: boolean;
  running: string | null;
  started: boolean;
}
const shared: Shared = ((globalThis as { __pvTldPerformance?: Shared }).__pvTldPerformance ??= {
  reports: null,
  settings: null,
  stateLoaded: false,
  running: null,
  started: false,
});

export function serverApiKey(): string | null {
  return process.env.PLUSVIBE_API_KEY?.trim() || null;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

async function writeJson(file: string, data: unknown) {
  await fs.mkdir(DIR, { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data), "utf8");
  await fs.rename(tmp, file);
}

// --- Settings and state --------------------------------------------------------

export async function loadTldSettings(): Promise<TldSettings> {
  if (shared.settings) return shared.settings;
  try {
    shared.settings = normalizeTldSettings(JSON.parse(await fs.readFile(SETTINGS_FILE, "utf8")));
  } catch {
    shared.settings = normalizeTldSettings(DEFAULT_TLD_SETTINGS);
  }
  return shared.settings;
}

export class TldSettingsProblem extends Error {
  constructor(readonly problems: string[]) {
    super(problems[0] ?? "The settings could not be saved.");
    this.name = "TldSettingsProblem";
  }
}

export async function saveTldSettings(patch: Record<string, unknown>): Promise<TldSettings> {
  const problems = validateTldPatch(patch);
  if (problems.length > 0) throw new TldSettingsProblem(problems);
  const current = await loadTldSettings();
  const rules = (patch.rules ?? {}) as Record<string, unknown>;
  const next = normalizeTldSettings({
    ...current,
    ...patch,
    rules: { ...current.rules, ...rules },
    updatedAt: Date.now(),
  });
  if (next.sheetUrl && !extractSheetId(next.sheetUrl)) {
    throw new TldSettingsProblem(["Sheet: that doesn't look like a Google Sheets link."]);
  }
  await writeJson(SETTINGS_FILE, next);
  shared.settings = next;
  return next;
}

async function loadState() {
  if (shared.stateLoaded) return;
  shared.stateLoaded = true;
  try {
    const s = JSON.parse(await fs.readFile(STATE_FILE, "utf8")) as { lastScheduledMonth?: string };
    shared.lastScheduledMonth = s.lastScheduledMonth;
  } catch {
    // never run
  }
}

async function saveState() {
  try {
    await writeJson(STATE_FILE, { lastScheduledMonth: shared.lastScheduledMonth });
  } catch {
    // best-effort
  }
}

// --- Reports on disk -----------------------------------------------------------

const fileFor = (id: string) => path.join(DIR, `report-${id}.json`);

async function loadReports(): Promise<Map<string, TldReport>> {
  if (shared.reports) return shared.reports;
  const map = new Map<string, TldReport>();
  try {
    await fs.mkdir(DIR, { recursive: true });
    for (const f of await fs.readdir(DIR)) {
      if (!f.startsWith("report-") || !f.endsWith(".json")) continue;
      try {
        const r = JSON.parse(await fs.readFile(path.join(DIR, f), "utf8")) as TldReport;
        // A run the process died in the middle of is not coming back.
        if (r.status === "running") r.status = "interrupted";
        r.errors = Array.isArray(r.errors) ? r.errors : [];
        map.set(r.id, r);
      } catch {
        // skip a corrupt file
      }
    }
  } catch {
    // nothing yet
  }
  shared.reports = map;
  return map;
}

async function persist(r: TldReport) {
  try {
    await writeJson(fileFor(r.id), r);
  } catch {
    // best-effort; the report is still in memory
  }
}

function summary(r: TldReport): TldReportSummary {
  const { body: _body, ...rest } = r;
  void _body;
  return rest;
}

export async function listReports(): Promise<TldReportSummary[]> {
  const map = await loadReports();
  return [...map.values()].map(summary).sort((a, b) => b.month.localeCompare(a.month) || b.createdAt - a.createdAt);
}

export async function getReport(id: string): Promise<TldReport | null> {
  return (await loadReports()).get(id) ?? null;
}

export async function deleteReport(id: string): Promise<boolean> {
  const map = await loadReports();
  const r = map.get(id);
  if (!r || r.status === "running") return false;
  map.delete(id);
  try {
    await fs.unlink(fileFor(id));
  } catch {
    // already gone
  }
  return true;
}

export async function status(now = Date.now()): Promise<TldStatus> {
  await loadState();
  const settings = await loadTldSettings();
  return {
    settings,
    reports: await listReports(),
    running: shared.running,
    nextRunAt: settings.enabled ? nextRunAt(now, shared.lastScheduledMonth) : null,
    serverKey: serverApiKey() !== null,
    sheetWriting: isSheetWritingConfigured(),
    lastFullMonth: lastFullMonth(now),
  };
}

// --- The run -------------------------------------------------------------------

export class TldBusy extends Error {
  constructor() {
    super("A report is already being made — let it finish first.");
    this.name = "TldBusy";
  }
}

/** Domain → Domain Host from 📋 Domains, named the way the platform tags name it. */
async function readHosts(): Promise<Map<string, string>> {
  const url = generalSettings().sheet.url;
  const id = extractSheetId(url) ?? envSpreadsheetId();
  if (!id) throw new Error("No Email Infra sheet is set in General Settings, so there is nowhere to read the registrars from.");
  const tab = domainsTab();
  // The service account when there is one — it reads private sheets too —
  // and otherwise the public export the rest of the app reads with.
  const grid = isSheetWritingConfigured() ? await readTab(id, tab) : await fetchSheetGrid(id, tab);
  const header = (grid[0] ?? []).map((h) => h.trim().toLowerCase());
  const dCol = header.indexOf("domain");
  const hCol = header.indexOf("domain host");
  if (dCol < 0 || hCol < 0) throw new Error(`${tab} has no "Domain" and "Domain Host" columns to read registrars from.`);
  const tags = generalSettings().tags.platform;
  const out = new Map<string, string>();
  for (const row of grid.slice(1)) {
    const domain = (row[dCol] ?? "").trim().toLowerCase();
    const host = (row[hCol] ?? "").trim();
    if (!domain || !host) continue;
    out.set(domain, findPlatformTag(host, tags)?.name ?? host);
  }
  return out;
}

function providerFromLabel(label: string | undefined): ProviderBucket | undefined {
  const l = (label ?? "").toLowerCase();
  if (l.includes("google")) return "google";
  if (l.includes("microsoft")) return "microsoft";
  return undefined;
}

/** Domains the Blocked Domains automation caught between two instants. */
async function blockedBetween(from: number, to: number): Promise<BlockedDomain[]> {
  const [domainJobs, inboxJobs, states] = await Promise.all([listDomainJobs(), listInboxJobs(), listInboxDomains()]);
  return statsEntries(inboxJobs, domainJobs, states)
    // "Stop sending to Google" is a domain still in use, not one lost.
    .filter((e) => !(e.googleStop && e.inboxes.length === 0 && !e.fromDomainRun))
    .filter((e) => e.firstBlockedAt >= from && e.firstBlockedAt < to)
    .map((e) => ({
      domain: e.domain.toLowerCase(),
      blockedAt: e.firstBlockedAt,
      provider: providerFromLabel(e.provider),
      platform: e.platform && e.platform !== "Unknown platform" ? e.platform : undefined,
    }));
}

async function writeSheet(r: TldReport, settings: TldSettings) {
  const id = extractSheetId(settings.sheetUrl);
  if (!id || !r.body) return;
  if (!isSheetWritingConfigured()) {
    r.sheet = { ok: false, error: "Google Sheets writing isn't set up (GOOGLE_SERVICE_ACCOUNT_JSON)." };
    return;
  }
  try {
    await ensureTab(id, settings.sheetTab);
    const grid = sheetGrid({
      month: r.month,
      combos: r.body.combos.all,
      totals: r.body.totals.all,
      view: "all",
      updated: describeDue(Date.now()),
    });
    await replaceTabValues(id, settings.sheetTab, grid);
    r.sheet = { ok: true, spreadsheetId: id, tab: settings.sheetTab, at: Date.now() };
  } catch (err) {
    r.sheet = { ok: false, spreadsheetId: id, tab: settings.sheetTab, error: msg(err) };
  }
}

async function run(apiKey: string, r: TldReport, settings: TldSettings) {
  const push = (e: string) => {
    if (r.errors.length < MAX_ERRORS) r.errors.push(e);
  };
  try {
    r.phase = "registrars";
    await persist(r);
    let hosts = new Map<string, string>();
    try {
      hosts = await readHosts();
    } catch (err) {
      push(`Registrars: ${msg(err)} Every domain is listed under ${UNKNOWN_PLATFORM}.`);
    }

    r.phase = "inboxes";
    const workspaces = await listWorkspaces(apiKey);
    r.progress = { workspacesDone: 0, workspacesTotal: workspaces.length, inboxes: 0 };
    await persist(r);

    const figures: InboxFigures[] = [];
    for (const w of workspaces) {
      try {
        const inboxes = await listInboxes(apiKey, w._id);
        if (inboxes.length > 0) {
          // The platform tags, by id: an inbox carries tag ids, and for the
          // domains the sheet doesn't list, its platform tag is the registrar.
          const platformNames = new Set(generalSettings().tags.platform.map((p) => p.name.trim().toLowerCase()));
          const tagPlatform = new Map<string, string>();
          try {
            await acquireSlot();
            for (const t of await listTags(apiKey, w._id)) {
              const n = t.name.trim().toLowerCase();
              if (!platformNames.has(n)) continue;
              // By id, and by name for an inbox whose tags come back as names.
              tagPlatform.set(t.id, n);
              tagPlatform.set(n, n);
            }
          } catch (err) {
            push(`${w.name}: its tags could not be read (${msg(err)}), so only the sheet names its registrars.`);
          }
          const { rows, errors } = await fetchInboxStats(apiKey, w._id, inboxes, { start: r.start, end: r.end });
          for (const e of errors) push(`${w.name}: ${e}`);
          const byId = new Map(rows.map((s) => [s.id, s]));
          const byEmail = new Map(rows.map((s) => [s.email, s]));
          for (const inbox of inboxes) {
            const s = byId.get(inbox.id) ?? byEmail.get(inbox.email.toLowerCase());
            if (!s || s.sent <= 0) continue;
            figures.push({
              workspaceId: w._id,
              workspaceName: w.name,
              domain: domainOfEmail(inbox.email),
              provider: bucketOf(inbox.provider),
              sent: s.sent,
              replies: s.replies,
              oooReplies: s.oooReplies,
              bounces: s.bounces ?? 0,
              platformTag: (inbox.tags ?? []).map((t) => tagPlatform.get(t) ?? tagPlatform.get(t.toLowerCase())).find(Boolean),
            });
          }
          r.progress.inboxes += inboxes.length;
        }
      } catch (err) {
        push(`${w.name}: could not be read (${msg(err)}).`);
      }
      r.progress.workspacesDone += 1;
      await persist(r);
    }

    r.phase = "blocks";
    const from = instantAt(r.start, 0);
    const [y, m] = r.month.split("-").map(Number);
    const nextMonth = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
    let blocked: BlockedDomain[] = [];
    try {
      blocked = await blockedBetween(from, instantAt(nextMonth, 0));
    } catch (err) {
      push(`Blocked domains could not be read: ${msg(err)}`);
    }

    r.body = buildReport(figures, blocked, (d) => hosts.get(d), settings.rules);
    r.rules = settings.rules;
    r.phase = "sheet";
    if (settings.sheetUrl) await writeSheet(r, settings);
    r.status = r.errors.length > 0 ? "error" : "done";
  } catch (err) {
    push(msg(err));
    r.status = "error";
  } finally {
    r.phase = "finished";
    r.finishedAt = Date.now();
    await persist(r);
  }
}

/**
 * Makes a month's report. A month already reported is replaced once the new
 * one has finished. Resolves when it is done.
 */
export async function runReport(
  apiKey: string,
  month: string,
  trigger: "manual" | "scheduled"
): Promise<TldReport> {
  if (shared.running) throw new TldBusy();
  const map = await loadReports();
  const settings = await loadTldSettings();
  const { start, end } = monthRange(month);
  const r: TldReport = {
    id: randomUUID(),
    month,
    start,
    end,
    trigger,
    status: "running",
    phase: "registrars",
    createdAt: Date.now(),
    progress: { workspacesDone: 0, workspacesTotal: 0, inboxes: 0 },
    rules: settings.rules,
    errors: [],
  };
  shared.running = r.id;
  map.set(r.id, r);
  try {
    await run(apiKey, r, settings);
    // The month's older reports go once a new one is in.
    if (r.body) {
      for (const [id, old] of map) {
        if (id !== r.id && old.month === month && old.status !== "running") await deleteReport(id);
      }
    }
    return r;
  } finally {
    shared.running = null;
  }
}

/** Starts a report and answers once it has started, or at once if one is going. */
export function startReport(apiKey: string, month: string, trigger: "manual" | "scheduled"): Promise<void> {
  if (shared.running) return Promise.reject(new TldBusy());
  void runReport(apiKey, month, trigger).catch(() => undefined);
  return Promise.resolve();
}

/** Writes an existing report to the sheet again, e.g. after setting the sheet. */
export async function resendToSheet(id: string): Promise<TldReport | null> {
  const r = await getReport(id);
  if (!r || !r.body) return null;
  const settings = await loadTldSettings();
  if (!settings.sheetUrl) throw new TldSettingsProblem(["Set a sheet first."]);
  await writeSheet(r, settings);
  await persist(r);
  return r;
}

// --- The schedule --------------------------------------------------------------

async function tick() {
  if (shared.running) return;
  try {
    const settings = await loadTldSettings();
    const key = serverApiKey();
    if (!settings.enabled || !key) return;
    await loadState();
    const now = Date.now();
    if (!isDue(now, shared.lastScheduledMonth)) return;
    const month = lastFullMonth(now);
    // Marked first: a run that fails is retried by hand, never in a loop.
    shared.lastScheduledMonth = month;
    await saveState();
    await runReport(key, month, "scheduled");
  } catch {
    // the next tick tries again; a failed run is recorded on its report
  }
}

export async function bootScheduler() {
  if (shared.started) return;
  shared.started = true;
  await loadState();
  await loadReports();
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  void tick();
}
