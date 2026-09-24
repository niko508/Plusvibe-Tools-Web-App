import "server-only";

import { randomUUID } from "crypto";
import { promises as fs, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { onShutdownFlush } from "@/lib/jobs/shutdown";
import { appendRows, batchUpdateCells, columnLetter, envSpreadsheetId, isSheetWritingConfigured, quoteTab, readTab } from "@/lib/google-sheets";
import { DEFAULT_SHEET_TAB, COL_DOMAIN, COL_STATUS, COL_TENANT_EMAIL, COL_TENANT_SOURCE } from "@/lib/jobs/azure-warmup-types";
import { COL_DOMAIN_HOST, GOOGLE_CANCEL_TAB, findDomainRow, headerIndex, matchWorkspaceByClient, planGoogleTabWrites } from "@/lib/blocked-domains/sheet-plan";
import { deleteInbox, fetchInboxStats, listInboxes, listWorkspaces, quarantineInboxes, type Inbox } from "@/lib/blocked-domains/api";
import { loadSettings } from "@/lib/blocked-domains/settings";
import { lookupRegistrar } from "@/lib/blocked-domains/registrar";
import { JUDGE_WINDOW_DAYS, describeRule, describeTier, judgeInbox } from "@/lib/blocked-inboxes/rules";
import { bucketOf } from "@/lib/plusvibe-providers";
import { daysAgo, toApiDate } from "@/lib/format";
import {
  MAX_INBOX_ERRORS,
  MAX_INBOX_HISTORY,
  type BlockedInboxJob,
} from "@/lib/jobs/blocked-inboxes-types";

// Server-side manager for the inbox-level Blocked Domains automation.
//
// Clay posts the sender inbox it saw bouncing. That inbox — and only that
// inbox — is found, read over its last 14 days and judged on its own tier
// (lib/blocked-inboxes/rules). A blocked inbox is stopped at once, listed on
// 🛑 Google Inboxes to Cancel when it is a Google one, and deleted: straight
// away with Auto-delete on, or when someone confirms.
//
// Driven by a webhook with no browser attached, so like the domain log this is
// one shared log read with the server's own key (PLUSVIBE_API_KEY).

const JOBS_BASE = process.env.JOBS_DIR || path.join(process.cwd(), ".jobs-data");
const RECORDS_DIR = path.join(JOBS_BASE, "blocked-inboxes", "records");

/**
 * How long a judgement stands. Clay fires on every bounce row, and one inbox
 * can bounce many times a day, so a hit inside this window is only counted. A
 * passed inbox that bounces again after it is judged again on fresh figures.
 * A blocked one is never judged again: it is stopped or gone.
 */
const REJUDGE_AFTER_MS = 24 * 60 * 60 * 1000;
/** Workspace listings and the Domains tab are reused this long across hits. */
const CACHE_MS = 10 * 60 * 1000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// One copy of the state per process, however many times Next.js loads this
// module (the start-up hook and the API routes are bundled apart).
interface SharedState {
  records: Map<string, BlockedInboxJob>;
  loaded: boolean;
  inboxCache: Map<string, { at: number; inboxes: Inbox[] }>;
  sheetCache?: { at: number; grid: string[][] };
}
const shared: SharedState = ((globalThis as { __pvBlockedInboxes?: SharedState }).__pvBlockedInboxes ??= {
  records: new Map(),
  loaded: false,
  inboxCache: new Map(),
});
const records = shared.records;

function serverApiKey(): string | null {
  return process.env.PLUSVIBE_API_KEY?.trim() || null;
}

// --- Persistence -----------------------------------------------------------

const fileFor = (id: string) => path.join(RECORDS_DIR, `${id}.json`);

async function persist(id: string) {
  const rec = records.get(id);
  if (!rec) return;
  try {
    await fs.mkdir(RECORDS_DIR, { recursive: true });
    await fs.writeFile(fileFor(id), JSON.stringify(rec), "utf8");
  } catch {
    // best-effort; a failed write must not kill the run
  }
}

onShutdownFlush(() => {
  const live = [...records.values()].filter((r) => r.status === "working" || r.status === "deleting");
  if (live.length === 0) return;
  try {
    mkdirSync(RECORDS_DIR, { recursive: true });
  } catch {
    return;
  }
  for (const rec of live) {
    rec.status = "interrupted";
    rec.updatedAt = Date.now();
    try {
      writeFileSync(fileFor(rec.id), JSON.stringify(rec), "utf8");
    } catch {
      // best-effort
    }
  }
});

async function loadOnce() {
  if (shared.loaded) return;
  shared.loaded = true;
  try {
    await fs.mkdir(RECORDS_DIR, { recursive: true });
    for (const f of await fs.readdir(RECORDS_DIR)) {
      if (!f.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(await fs.readFile(path.join(RECORDS_DIR, f), "utf8")) as BlockedInboxJob;
        if (rec.status === "working" || rec.status === "deleting") rec.status = "interrupted";
        rec.errors = Array.isArray(rec.errors) ? rec.errors : [];
        rec.duplicateHits = rec.duplicateHits ?? 0;
        records.set(rec.id, rec);
      } catch {
        // skip a corrupt record
      }
    }
  } catch {
    // nothing to load
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

function pushError(rec: BlockedInboxJob, text: string) {
  if (rec.errors.length < MAX_INBOX_ERRORS) rec.errors.push(text);
}

export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const e = input.trim().toLowerCase().replace(/^mailto:/, "");
  return EMAIL_RE.test(e) ? e : null;
}

// --- Intake ----------------------------------------------------------------

export type InboxIntakeResult =
  | { outcome: "accepted"; job: BlockedInboxJob }
  | { outcome: "duplicate"; job: BlockedInboxJob }
  | { outcome: "invalid"; reason: string };

/** Whether a new hit for an inbox is only counted, rather than run. */
function standsAsIs(rec: BlockedInboxJob, now: number): boolean {
  if (rec.status === "working" || rec.status === "deleting") return true;
  if (rec.blockedAt !== undefined) return true;
  return now - (rec.judgedAt ?? rec.createdAt) < REJUDGE_AFTER_MS;
}

export async function intakeInbox(args: { email: unknown; bounceReason?: string; source?: string }): Promise<InboxIntakeResult> {
  await loadOnce();
  const email = normalizeEmail(args.email);
  if (!email) return { outcome: "invalid", reason: `"${String(args.email ?? "")}" is not an email address` };
  const now = Date.now();

  const existing = [...records.values()].filter((r) => r.email === email).sort((a, b) => b.createdAt - a.createdAt)[0];
  if (existing && standsAsIs(existing, now)) {
    existing.duplicateHits += 1;
    existing.lastDuplicateAt = now;
    existing.updatedAt = now;
    await persist(existing.id);
    return { outcome: "duplicate", job: existing };
  }

  let rec: BlockedInboxJob;
  if (existing) {
    // Judged before and not blocked: judged again on fresh figures, on the
    // same record, keeping what it said last time.
    rec = existing;
    if (rec.verdict && rec.figures && rec.rates && rec.judgedAt) {
      rec.history = [
        { at: rec.judgedAt, verdict: rec.verdict, sent: rec.figures.sent, bounceRate: rec.rates.bounceRate, oooReplyRate: rec.rates.oooReplyRate },
        ...(rec.history ?? []),
      ].slice(0, MAX_INBOX_HISTORY);
    }
    rec.status = "working";
    rec.errors = [];
    rec.overruled = undefined;
    rec.reasons = undefined;
    rec.updatedAt = now;
    if (args.bounceReason) rec.bounceReason = args.bounceReason.slice(0, 500);
  } else {
    rec = {
      id: randomUUID(),
      email,
      domain: email.slice(email.lastIndexOf("@") + 1),
      status: "working",
      createdAt: now,
      updatedAt: now,
      source: args.source || "clay",
      bounceReason: args.bounceReason?.slice(0, 500) || undefined,
      duplicateHits: 0,
      errors: [],
    };
    records.set(rec.id, rec);
  }
  await persist(rec.id);
  void runInbox(rec.id);
  return { outcome: "accepted", job: rec };
}

// --- Finding the inbox -------------------------------------------------------

async function domainsGrid(): Promise<string[][] | null> {
  const sheetId = envSpreadsheetId();
  if (!sheetId) return null;
  const c = shared.sheetCache;
  if (c && Date.now() - c.at < CACHE_MS) return c.grid;
  const grid = await readTab(sheetId, DEFAULT_SHEET_TAB);
  shared.sheetCache = { at: Date.now(), grid };
  return grid;
}

async function workspaceInboxes(apiKey: string, workspaceId: string, fresh = false): Promise<Inbox[]> {
  const c = shared.inboxCache.get(workspaceId);
  if (!fresh && c && Date.now() - c.at < CACHE_MS) return c.inboxes;
  const inboxes = await listInboxes(apiKey, workspaceId);
  shared.inboxCache.set(workspaceId, { at: Date.now(), inboxes });
  return inboxes;
}

/**
 * The inbox, and the workspace it is in. The Domains sheet's Client column
 * points at the workspace when it can; otherwise every workspace is looked
 * through. Workspace listings are reused for a few minutes, since one bad
 * domain sends many of its inboxes through here in a burst.
 */
async function locate(apiKey: string, rec: BlockedInboxJob): Promise<{ workspaceId: string; workspaceName: string; inbox: Inbox } | null> {
  const workspaces = await listWorkspaces(apiKey);
  let hinted: string | null = null;
  try {
    const grid = await domainsGrid();
    if (grid) {
      const header = grid[0] ?? [];
      const hit = findDomainRow(grid, rec.domain, {
        domain: headerIndex(header, COL_DOMAIN),
        status: headerIndex(header, COL_STATUS),
        tenantEmail: headerIndex(header, COL_TENANT_EMAIL),
        tenantSource: headerIndex(header, COL_TENANT_SOURCE),
        client: headerIndex(header, "Client"),
        domainHost: headerIndex(header, COL_DOMAIN_HOST),
      });
      if (hit.row) {
        rec.client = hit.row.client || undefined;
        rec.domainHost = hit.row.domainHost || undefined;
        rec.tenantSource = hit.row.tenantSource || undefined;
        if (rec.client) hinted = matchWorkspaceByClient(rec.client, workspaces);
      }
    }
  } catch (err) {
    pushError(rec, `Could not read the Domains sheet for a workspace hint: ${msg(err)}`);
  }

  const order = hinted ? [hinted, ...workspaces.map((w) => w._id).filter((id) => id !== hinted)] : workspaces.map((w) => w._id);
  const find = (inboxes: Inbox[]) => inboxes.find((i) => i.email.trim().toLowerCase() === rec.email);
  const nameOf = (wsId: string) => workspaces.find((w) => w._id === wsId)?.name ?? "";
  // Workspaces read from Plusvibe during this lookup, rather than reused.
  const readNow = new Set<string>();
  const listing = async (wsId: string, fresh: boolean) => {
    const cached = shared.inboxCache.get(wsId);
    const inboxes = await workspaceInboxes(apiKey, wsId, fresh);
    if (fresh || !cached || Date.now() - cached.at >= CACHE_MS) readNow.add(wsId);
    return inboxes;
  };
  for (const wsId of order) {
    const hit = find(await listing(wsId, false));
    if (hit) return { workspaceId: wsId, workspaceName: nameOf(wsId), inbox: hit };
  }
  // Not in any listing — but a listing reused from the cache may predate the
  // inbox, so those workspaces are read again, fresh, before giving up.
  for (const wsId of order) {
    if (readNow.has(wsId)) continue;
    const hit = find(await listing(wsId, true));
    if (hit) return { workspaceId: wsId, workspaceName: nameOf(wsId), inbox: hit };
  }
  return null;
}

// --- The run -----------------------------------------------------------------

async function runInbox(id: string) {
  const rec = records.get(id);
  if (!rec) return;
  const apiKey = serverApiKey();
  if (!apiKey) {
    rec.status = "error";
    pushError(rec, "PLUSVIBE_API_KEY is not set on the server, so there is no key to find the inbox with.");
    await persist(id);
    return;
  }

  try {
    // 1. Find it.
    const found = await locate(apiKey, rec);
    if (!found) {
      rec.status = "not_found";
      rec.judgedAt = Date.now();
      pushError(rec, `${rec.email} is not in any workspace — it may already be deleted. Nothing was done.`);
      rec.updatedAt = Date.now();
      await persist(id);
      return;
    }
    rec.workspaceId = found.workspaceId;
    rec.workspaceName = found.workspaceName;
    rec.accountId = found.inbox.id;
    rec.providerRaw = found.inbox.provider;
    rec.provider = bucketOf(found.inbox.provider);
    if (!rec.domainHost && !rec.registrar) rec.registrar = (await lookupRegistrar(rec.domain)) ?? undefined;
    await persist(id);

    // 2. Its last 14 days.
    const window = { start: toApiDate(daysAgo(JUDGE_WINDOW_DAYS - 1)), end: toApiDate(new Date()) };
    rec.window = window;
    const { rows, errors } = await fetchInboxStats(apiKey, found.workspaceId, [found.inbox], window);
    const row = rows.find((r) => r.id === found.inbox.id || r.email === rec.email) ?? rows[0];
    if (!row) {
      // Deleting on no figures would be deleting on a guess.
      rec.status = "error";
      rec.judgedAt = Date.now();
      for (const e of errors) pushError(rec, e);
      pushError(rec, `Could not read ${rec.email}'s last ${JUDGE_WINDOW_DAYS} days, so it was not judged and nothing was done.`);
      rec.updatedAt = Date.now();
      await persist(id);
      return;
    }
    rec.figures = { sent: row.sent, bounces: row.bounces ?? 0, contacted: row.contacted, replies: row.replies, oooReplies: row.oooReplies };

    // 3. Judge it.
    const j = judgeInbox(rec.provider, rec.figures);
    rec.rates = j.rates;
    rec.verdict = j.verdict;
    rec.tier = j.tier ? describeTier(j.tier) : undefined;
    rec.rule = j.tier ? describeRule(j.tier) : undefined;
    rec.reasons = j.reasons;
    rec.overruled = j.overruled;
    rec.judgedAt = Date.now();
    if (j.verdict !== "block") {
      rec.status = j.verdict === "untouched" ? "untouched" : "passed";
      rec.updatedAt = Date.now();
      await persist(id);
      return;
    }

    // 4. Blocked: stop it now — reversible, so it doesn't wait for anyone.
    rec.blockedAt = Date.now();
    try {
      const q = await quarantineInboxes(apiKey, found.workspaceId, [found.inbox.id]);
      rec.sendingStopped = q.sendingStopped;
      rec.warmupStopped = q.warmupStopped;
      for (const e of q.errors) pushError(rec, `Could not stop ${e}`);
    } catch (err) {
      pushError(rec, `Could not stop sending and warmup: ${msg(err)}`);
    }
    await persist(id);

    // A Google inbox is its own seat, so it goes on the cancel list.
    if (rec.provider === "google") await listOnGoogleCancel(rec);

    // 5. Delete — now, or when someone confirms.
    const settings = await loadSettings();
    if (settings.autoDelete) {
      rec.autoDeleted = true;
      rec.confirmedAt = Date.now();
      await persist(id);
      await runDelete(id);
    } else {
      rec.status = "awaiting_confirmation";
      rec.updatedAt = Date.now();
      await persist(id);
    }
  } catch (err) {
    rec.status = "error";
    pushError(rec, msg(err));
    rec.updatedAt = Date.now();
    await persist(id);
  }
}

/** Lists a burned Google inbox on 🛑 Google Inboxes to Cancel, once. */
async function listOnGoogleCancel(rec: BlockedInboxJob) {
  const sheetId = envSpreadsheetId();
  if (!sheetId || !isSheetWritingConfigured()) {
    rec.googleCancel = { listed: false, error: "The sheet isn't set up for writing, so it was not listed." };
    pushError(rec, `${rec.email} was not listed on "${GOOGLE_CANCEL_TAB}": the sheet isn't set up for writing.`);
    return;
  }
  try {
    const grid = await readTab(sheetId, GOOGLE_CANCEL_TAB);
    const plan = planGoogleTabWrites(grid, [rec.email], rec.tenantSource ?? "");
    if (plan.problem) {
      rec.googleCancel = { listed: false, error: plan.problem };
      pushError(rec, plan.problem);
      return;
    }
    if (plan.updates.length > 0) {
      await batchUpdateCells(
        sheetId,
        plan.updates.map((u) => ({ range: `${quoteTab(GOOGLE_CANCEL_TAB)}!${columnLetter(u.column)}${u.row}`, value: u.value }))
      );
    }
    if (plan.append.length > 0) await appendRows(sheetId, GOOGLE_CANCEL_TAB, plan.append);
    rec.googleCancel = { listed: true, alreadyThere: plan.already.length > 0 && plan.queued.length === 0 && plan.moved.length === 0 };
  } catch (err) {
    rec.googleCancel = { listed: false, error: msg(err) };
    pushError(rec, `Could not list ${rec.email} on "${GOOGLE_CANCEL_TAB}": ${msg(err)}`);
  }
}

async function runDelete(id: string) {
  const rec = records.get(id);
  if (!rec || !rec.workspaceId) return;
  const apiKey = serverApiKey();
  if (!apiKey) {
    pushError(rec, "PLUSVIBE_API_KEY is not set on the server, so the inbox could not be deleted.");
    await persist(id);
    return;
  }
  rec.status = "deleting";
  await persist(id);
  try {
    await deleteInbox(apiKey, rec.workspaceId, rec.email);
    rec.deletedAt = Date.now();
    rec.status = "deleted";
    shared.inboxCache.delete(rec.workspaceId);
  } catch (err) {
    rec.status = "awaiting_confirmation";
    pushError(rec, `Could not delete ${rec.email}: ${msg(err)}. It is still stopped; try again.`);
  }
  rec.updatedAt = Date.now();
  await persist(id);
}

// --- Control ---------------------------------------------------------------

export async function listInboxJobs(): Promise<BlockedInboxJob[]> {
  await loadOnce();
  return [...records.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/** Deletes a blocked inbox someone has confirmed. */
export async function confirmInbox(id: string): Promise<boolean> {
  await loadOnce();
  const rec = records.get(id);
  if (!rec || rec.status !== "awaiting_confirmation") return false;
  rec.confirmedAt = Date.now();
  await runDelete(id);
  return true;
}

/** Deletes every blocked inbox waiting for confirmation, one after another. */
export async function confirmAllInboxes(): Promise<number> {
  await loadOnce();
  const waiting = [...records.values()].filter((r) => r.status === "awaiting_confirmation");
  for (const r of waiting) r.confirmedAt = Date.now();
  void (async () => {
    for (const r of waiting) await runDelete(r.id);
  })();
  return waiting.length;
}

/** Keeps a blocked inbox: not deleted, left stopped. */
export async function dismissInbox(id: string): Promise<boolean> {
  await loadOnce();
  const rec = records.get(id);
  if (!rec || rec.status !== "awaiting_confirmation") return false;
  rec.status = "dismissed";
  rec.dismissedAt = Date.now();
  rec.updatedAt = Date.now();
  await persist(id);
  return true;
}

/** Forgets a run, so the next hit for that inbox is judged afresh. */
export async function removeInboxJob(id: string): Promise<boolean> {
  await loadOnce();
  const rec = records.get(id);
  if (!rec || rec.status === "working" || rec.status === "deleting") return false;
  records.delete(id);
  try {
    await fs.unlink(fileFor(id));
  } catch {
    // already gone
  }
  return true;
}
