import "server-only";

import { randomUUID } from "crypto";
import { promises as fs, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { onShutdownFlush } from "@/lib/jobs/shutdown";
import {
  GoogleSheetsError,
  appendRows,
  batchUpdateCells,
  columnLetter,
  envSpreadsheetId,
  isSheetWritingConfigured,
  quoteTab,
  readTab,
} from "@/lib/google-sheets";
import { DEFAULT_SHEET_TAB, COL_DOMAIN, COL_STATUS, COL_TENANT_EMAIL, COL_TENANT_SOURCE } from "@/lib/jobs/azure-warmup-types";
import {
  BLOCKED_STATUS,
  CANCEL_TAB,
  COL_DOMAIN_HOST,
  GOOGLE_CANCEL_TAB,
  TENANT_QUEUE,
  findDomainRow,
  headerIndex,
  matchWorkspaceByClient,
  planGoogleTabWrites,
  planQueueTabWrites,
} from "@/lib/blocked-domains/sheet-plan";
import { deleteInbox, fetchInboxStats, listInboxes, listWorkspaces, quarantineInboxes, type Inbox } from "@/lib/blocked-domains/api";
import type { Workspace } from "@/lib/plusvibe-types";
import { loadSettings } from "@/lib/blocked-domains/settings";
import { lookupRegistrar } from "@/lib/blocked-domains/registrar";
import { JUDGE_WINDOW_DAYS, describeRule, describeTier, judgeInbox, ratesOf } from "@/lib/blocked-inboxes/rules";
import { isLastOnDomain, planCancellation, shouldCancel } from "@/lib/blocked-inboxes/domain-endings";
import { bucketOf } from "@/lib/plusvibe-providers";
import { daysAgo, toApiDate } from "@/lib/format";
import {
  MAX_INBOX_ERRORS,
  MAX_INBOX_HISTORY,
  type BlockedInboxJob,
  type InboxDomainState,
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
/** What has been done to each domain: the Microsoft deletion count, Not Active, cancellation. */
const DOMAINS_FILE = path.join(JOBS_BASE, "blocked-inboxes", "domains.json");

/**
 * How long a judgement stands. Clay fires on every bounce row, and one inbox
 * can bounce many times a day, so a hit inside this window is only counted. A
 * passed inbox that bounces again after it is judged again on fresh figures.
 * A blocked one is never judged again: it is stopped or gone.
 */
const REJUDGE_AFTER_MS = 24 * 60 * 60 * 1000;
/** Workspace listings and the Domains tab are reused this long across hits. */
const CACHE_MS = 10 * 60 * 1000;
/**
 * How recent a listing must be to decide that a Google inbox is its domain's
 * last. Recent enough to see inboxes added since; not so recent that every
 * blocked Google inbox reads its whole workspace again.
 */
const FRESH_MS = 2 * 60 * 1000;
/**
 * How many inboxes are checked at once; the rest wait in line. Clay can send
 * hundreds in one go, and every Plusvibe call shares one small rate budget:
 * started all together, they only slow each other down until none finishes.
 */
const MAX_RUNS = 3;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// One copy of the state per process, however many times Next.js loads this
// module (the start-up hook and the API routes are bundled apart).
interface SharedState {
  records: Map<string, BlockedInboxJob>;
  domains: Map<string, InboxDomainState>;
  /** The log's first read from disk; everyone waits on the same one. */
  loading?: Promise<void>;
  inboxCache: Map<string, { at: number; inboxes: Inbox[] }>;
  sheetCache?: { at: number; grid: string[][] };
  workspaces?: { at: number; list: Workspace[] };
  /** Reads under way, so a burst shares one instead of each starting its own. */
  inflight: Map<string, Promise<unknown>>;
  /** Inboxes waiting their turn, and how many are being checked now. */
  queue: { id: string; kind: "run" | "delete" }[];
  active: number;
  /** Sheet calls go one at a time: they read a tab, then write where it was blank. */
  sheetChain: Promise<void>;
  /** Registrar per domain: one lookup serves all of a domain's inboxes. */
  registrars?: Map<string, Promise<string | null>>;
}
const shared: SharedState = ((globalThis as { __pvBlockedInboxes?: SharedState }).__pvBlockedInboxes ??= {
  records: new Map(),
  domains: new Map(),
  inboxCache: new Map(),
  inflight: new Map(),
  queue: [],
  active: 0,
  sheetChain: Promise.resolve(),
});
const records = shared.records;
const domains = shared.domains;

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

/**
 * A run a restart cut off carries on by itself. Nothing irreversible happens
 * before an inbox is blocked, so one cut off before that is simply checked
 * again. One cut off after it is already stopped: it waits for its deletion
 * as usual — and if that deletion had been confirmed, it is carried out.
 */
function resumeAfterRestart(rec: BlockedInboxJob): "run" | "delete" | null {
  const cutOff = rec.status === "queued" || rec.status === "working" || rec.status === "deleting" || rec.status === "interrupted";
  if (!cutOff) return null;
  if (rec.blockedAt === undefined) {
    rec.status = "queued";
    return "run";
  }
  rec.status = "awaiting_confirmation";
  return rec.confirmedAt !== undefined ? "delete" : null;
}

function loadOnce(): Promise<void> {
  return (shared.loading ??= load());
}

async function load() {
  const resume: { rec: BlockedInboxJob; kind: "run" | "delete" }[] = [];
  try {
    await fs.mkdir(RECORDS_DIR, { recursive: true });
    for (const f of await fs.readdir(RECORDS_DIR)) {
      if (!f.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(await fs.readFile(path.join(RECORDS_DIR, f), "utf8")) as BlockedInboxJob;
        rec.errors = Array.isArray(rec.errors) ? rec.errors : [];
        rec.duplicateHits = rec.duplicateHits ?? 0;
        records.set(rec.id, rec);
        const kind = resumeAfterRestart(rec);
        if (kind) resume.push({ rec, kind });
      } catch {
        // skip a corrupt record
      }
    }
  } catch {
    // nothing to load
  }
  try {
    const list = JSON.parse(await fs.readFile(DOMAINS_FILE, "utf8")) as InboxDomainState[];
    for (const d of list) {
      d.cancelling = false; // a cancellation cut off by a restart is not still running
      d.errors = Array.isArray(d.errors) ? d.errors : [];
      domains.set(d.domain, d);
    }
  } catch {
    // First start with domain records: the Microsoft deletions made before
    // they were kept still count towards each domain's cancellation.
    for (const r of records.values()) {
      if (r.provider !== "microsoft" || r.status !== "deleted" || r.cancelledWithDomain) continue;
      const d = domainState(r.domain);
      d.deletedByRules += 1;
      d.provider = "microsoft";
      d.workspaceId = d.workspaceId ?? r.workspaceId;
      d.workspaceName = d.workspaceName ?? r.workspaceName;
    }
    await persistDomains();
  }
  // Oldest first, as they arrived.
  for (const { rec, kind } of resume.sort((a, b) => a.rec.createdAt - b.rec.createdAt)) enqueue(rec.id, kind);
}

/** Loads the log at boot, so runs a deploy cut off carry on with nobody looking. */
export async function bootResume(): Promise<void> {
  await loadOnce();
}

// --- The line --------------------------------------------------------------

function enqueue(id: string, kind: "run" | "delete") {
  if (shared.queue.some((q) => q.id === id)) return;
  shared.queue.push({ id, kind });
  pump();
}

function pump() {
  while (shared.active < MAX_RUNS && shared.queue.length > 0) {
    const next = shared.queue.shift()!;
    shared.active += 1;
    const task = next.kind === "run" ? runInbox(next.id) : runDelete(next.id);
    void task
      .catch(() => undefined)
      .finally(() => {
        shared.active -= 1;
        pump();
      });
  }
}

/** One read at a time per key: callers arriving while it runs get the same answer. */
function once<T>(key: string, make: () => Promise<T>): Promise<T> {
  const running = shared.inflight.get(key) as Promise<T> | undefined;
  if (running) return running;
  const p = make().finally(() => shared.inflight.delete(key));
  shared.inflight.set(key, p);
  return p;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Every sheet call, one after another, and tried again when Google says to
 * slow down. One at a time because the cancel tabs are filled by reading them
 * and writing to the first blank row: two at once would pick the same row.
 */
function withSheet<T>(fn: () => Promise<T>): Promise<T> {
  const run = shared.sheetChain.then(async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const busy = err instanceof GoogleSheetsError && (err.status === 429 || err.status >= 500);
        if (!busy || attempt >= 5) throw err;
        await sleep(2000 * 2 ** attempt);
      }
    }
  });
  shared.sheetChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function domainState(domain: string): InboxDomainState {
  let d = domains.get(domain);
  if (!d) {
    d = { domain, deletedByRules: 0, errors: [], updatedAt: Date.now() };
    domains.set(domain, d);
  }
  return d;
}

async function persistDomains() {
  try {
    await fs.mkdir(path.dirname(DOMAINS_FILE), { recursive: true });
    const tmp = `${DOMAINS_FILE}.tmp`;
    await fs.writeFile(tmp, JSON.stringify([...domains.values()]), "utf8");
    await fs.rename(tmp, DOMAINS_FILE);
  } catch {
    // best-effort, like the records
  }
}

function domainError(d: InboxDomainState, text: string) {
  if (d.errors.length < MAX_INBOX_ERRORS) d.errors.push(text);
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
  if (rec.status === "queued" || rec.status === "working" || rec.status === "deleting") return true;
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
    rec.status = "queued";
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
      status: "queued",
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
  enqueue(rec.id, "run");
  return { outcome: "accepted", job: rec };
}

// --- Finding the inbox -------------------------------------------------------

async function domainsGrid(): Promise<string[][] | null> {
  const sheetId = envSpreadsheetId();
  if (!sheetId) return null;
  const c = shared.sheetCache;
  if (c && Date.now() - c.at < CACHE_MS) return c.grid;
  return once("sheet:domains", () =>
    withSheet(async () => {
      const grid = await readTab(sheetId, DEFAULT_SHEET_TAB);
      shared.sheetCache = { at: Date.now(), grid };
      return grid;
    })
  );
}

async function workspaceList(apiKey: string): Promise<Workspace[]> {
  const c = shared.workspaces;
  if (c && Date.now() - c.at < CACHE_MS) return c.list;
  return once("workspaces", async () => {
    const list = await listWorkspaces(apiKey);
    shared.workspaces = { at: Date.now(), list };
    return list;
  });
}

/**
 * A workspace's inboxes, as read at `readSince` or later: the cached listing
 * when it is that recent, a read already under way when that started late
 * enough, and otherwise a new read.
 */
async function workspaceInboxes(apiKey: string, workspaceId: string, readSince = Date.now() - CACHE_MS): Promise<Inbox[]> {
  const c = shared.inboxCache.get(workspaceId);
  if (c && c.at >= readSince) return c.inboxes;
  const key = `inboxes:${workspaceId}`;
  const running = shared.inflight.get(key) as (Promise<Inbox[]> & { startedAt?: number }) | undefined;
  if (running && (running.startedAt ?? 0) >= readSince) return running;
  const startedAt = Date.now();
  const p: Promise<Inbox[]> & { startedAt?: number } = listInboxes(apiKey, workspaceId).then((inboxes) => {
    shared.inboxCache.set(workspaceId, { at: startedAt, inboxes });
    return inboxes;
  });
  p.startedAt = startedAt;
  shared.inflight.set(key, p);
  void p.finally(() => {
    if (shared.inflight.get(key) === p) shared.inflight.delete(key);
  }).catch(() => undefined);
  return p;
}

/**
 * The inbox, and the workspace it is in. The Domains sheet's Client column
 * points at the workspace when it can; otherwise every workspace is looked
 * through. Workspace listings are shared and reused for a few minutes, since
 * Clay sends inboxes in bursts — sometimes hundreds at once.
 *
 * `arrivedAt` is when the hit came in. An inbox missing from a listing read
 * before then may be newer than the listing, so that workspace is read again;
 * one missing from a listing read after it is simply not there. That keeps a
 * burst of already-deleted inboxes to one fresh read, not one each.
 */
async function locate(
  apiKey: string,
  rec: BlockedInboxJob,
  arrivedAt: number
): Promise<{ workspaceId: string; workspaceName: string; inbox: Inbox } | null> {
  const workspaces = await workspaceList(apiKey);
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
  for (const wsId of order) {
    const hit = find(await workspaceInboxes(apiKey, wsId));
    if (hit) return { workspaceId: wsId, workspaceName: nameOf(wsId), inbox: hit };
  }
  // Not in any listing — but a listing read before the hit arrived may
  // predate the inbox, so those workspaces are read again before giving up.
  for (const wsId of order) {
    if ((shared.inboxCache.get(wsId)?.at ?? 0) >= arrivedAt) continue;
    const hit = find(await workspaceInboxes(apiKey, wsId, arrivedAt));
    if (hit) return { workspaceId: wsId, workspaceName: nameOf(wsId), inbox: hit };
  }
  return null;
}

function registrarOf(domain: string): Promise<string | null> {
  const cache = (shared.registrars ??= new Map());
  let p = cache.get(domain);
  if (!p) {
    p = lookupRegistrar(domain);
    cache.set(domain, p);
  }
  return p;
}

// --- The run -----------------------------------------------------------------

async function runInbox(id: string) {
  const rec = records.get(id);
  // Removed while it waited, or already handled some other way.
  if (!rec || rec.status !== "queued") return;
  const arrivedAt = rec.updatedAt;
  rec.status = "working";
  rec.updatedAt = Date.now();
  const apiKey = serverApiKey();
  if (!apiKey) {
    rec.status = "error";
    pushError(rec, "PLUSVIBE_API_KEY is not set on the server, so there is no key to find the inbox with.");
    await persist(id);
    return;
  }

  try {
    // 1. Find it.
    const found = await locate(apiKey, rec, arrivedAt);
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
    if (!rec.domainHost && !rec.registrar) rec.registrar = (await registrarOf(rec.domain)) ?? undefined;
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

    // 3. Judge it, on the rules as saved on the Settings tab.
    const settings = await loadSettings();
    const j = judgeInbox(rec.provider, rec.figures, settings.inboxRules);
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

    // A Google inbox is its own seat, so it goes on the cancel list — and
    // when it was the last one on its domain, the domain is finished too.
    if (rec.provider === "google") {
      await listOnGoogleCancel(rec);
      await endGoogleDomainIfLast(apiKey, rec);
    }

    // 5. Delete — now, or when someone confirms.
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
    await withSheet(async () => {
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
    });
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
    // Out of the cached listing too — rather than dropping the listing, which
    // would have the next inbox read the whole workspace again.
    const c = shared.inboxCache.get(rec.workspaceId);
    if (c) c.inboxes = c.inboxes.filter((i) => i.email.trim().toLowerCase() !== rec.email);
  } catch (err) {
    rec.status = "awaiting_confirmation";
    pushError(rec, `Could not delete ${rec.email}: ${msg(err)}. It is still stopped; try again.`);
  }
  rec.updatedAt = Date.now();
  await persist(id);

  // Every Microsoft inbox the rules delete counts towards its domain's
  // cancellation. The cancellation's own deletions don't: by then the domain
  // is already cancelled.
  if (rec.status === "deleted" && rec.provider === "microsoft" && !rec.cancelledWithDomain) {
    const d = domainState(rec.domain);
    d.deletedByRules += 1;
    d.provider = "microsoft";
    d.workspaceId = rec.workspaceId;
    d.workspaceName = rec.workspaceName ?? d.workspaceName;
    d.updatedAt = Date.now();
    await persistDomains();
    const settings = await loadSettings();
    if (shouldCancel(d, settings.cancelAfterDeleted)) void cancelMicrosoftDomain(rec.domain);
  }
}

// --- Domain endings -----------------------------------------------------------

/** Emails on a domain this automation has already blocked (stopped or deleted). */
function blockedOn(domain: string, except?: string): string[] {
  return [...records.values()].filter((r) => r.domain === domain && r.blockedAt !== undefined && r.email !== except).map((r) => r.email);
}

/**
 * Google: once the inbox just blocked is the last one standing on its domain,
 * the domain goes Not Active in 📋 Domains.
 */
async function endGoogleDomainIfLast(apiKey: string, rec: BlockedInboxJob) {
  if (!rec.workspaceId) return;
  try {
    const onDomain = (await workspaceInboxes(apiKey, rec.workspaceId, Date.now() - FRESH_MS))
      .map((i) => i.email.trim().toLowerCase())
      .filter((e) => e.endsWith(`@${rec.domain}`));
    if (!isLastOnDomain(onDomain, rec.email, blockedOn(rec.domain, rec.email))) return;
    rec.lastOnDomain = true;
    const d = domainState(rec.domain);
    d.provider = "google";
    d.workspaceId = rec.workspaceId;
    d.workspaceName = rec.workspaceName ?? d.workspaceName;
    const r = await setDomainNotActive(rec.domain);
    if (r.error) {
      domainError(d, r.error);
      pushError(rec, `This was the last inbox on ${rec.domain}, but it could not be set Not Active: ${r.error}`);
    } else {
      d.notActiveAt = Date.now();
      d.notActiveReason = "last-google-inbox";
      d.previousStatus = r.previousStatus;
    }
    d.updatedAt = Date.now();
    await persistDomains();
    await persist(rec.id);
  } catch (err) {
    pushError(rec, `Could not check whether this was the last inbox on ${rec.domain}: ${msg(err)}`);
  }
}

/** The domain's row in 📋 Domains, set to Not Active. Reports the tenant it names. */
async function setDomainNotActive(
  domain: string
): Promise<{ error?: string; previousStatus?: string; tenantEmail?: string; tenantSource?: string }> {
  const sheetId = envSpreadsheetId();
  if (!sheetId || !isSheetWritingConfigured()) return { error: "the sheet isn't set up for writing" };
  return withSheet(() => writeNotActive(sheetId, domain));
}

async function writeNotActive(
  sheetId: string,
  domain: string
): Promise<{ error?: string; previousStatus?: string; tenantEmail?: string; tenantSource?: string }> {
  const grid = await readTab(sheetId, DEFAULT_SHEET_TAB);
  shared.sheetCache = { at: Date.now(), grid };
  const header = grid[0] ?? [];
  const iStatus = headerIndex(header, COL_STATUS);
  const hit = findDomainRow(grid, domain, {
    domain: headerIndex(header, COL_DOMAIN),
    status: iStatus,
    tenantEmail: headerIndex(header, COL_TENANT_EMAIL),
    tenantSource: headerIndex(header, COL_TENANT_SOURCE),
    client: headerIndex(header, "Client"),
    domainHost: headerIndex(header, COL_DOMAIN_HOST),
  });
  if (!hit.row) return { error: `${domain} isn't in the "${DEFAULT_SHEET_TAB}" tab` };
  if (iStatus < 0) return { error: `the "${DEFAULT_SHEET_TAB}" tab has no ${COL_STATUS} column` };
  await batchUpdateCells(sheetId, [
    { range: `${quoteTab(DEFAULT_SHEET_TAB)}!${columnLetter(iStatus)}${hit.row.rowNumber}`, value: BLOCKED_STATUS },
  ]);
  return {
    previousStatus: hit.row.currentStatus,
    tenantEmail: hit.row.tenantEmail || undefined,
    tenantSource: hit.row.tenantSource || undefined,
  };
}

/** The domain and its tenant onto 🚯 Tenants to Cancel, once. */
async function queueTenant(domain: string, tenant: string, source: string): Promise<{ queued: boolean; already: boolean; error?: string }> {
  const sheetId = envSpreadsheetId();
  if (!sheetId || !isSheetWritingConfigured()) return { queued: false, already: false, error: "the sheet isn't set up for writing" };
  return withSheet(() => writeTenant(sheetId, domain, tenant, source));
}

async function writeTenant(sheetId: string, domain: string, tenant: string, source: string): Promise<{ queued: boolean; already: boolean; error?: string }> {
  const grid = await readTab(sheetId, CANCEL_TAB);
  const plan = planQueueTabWrites(grid, [{ key: tenant, source, domain }], TENANT_QUEUE);
  if (plan.problem) return { queued: false, already: false, error: plan.problem };
  if (plan.already.length > 0) return { queued: false, already: true };
  if (plan.updates.length > 0) {
    await batchUpdateCells(
      sheetId,
      plan.updates.map((u) => ({ range: `${quoteTab(CANCEL_TAB)}!${columnLetter(u.column)}${u.row}`, value: u.value }))
    );
  }
  if (plan.append.length > 0) await appendRows(sheetId, CANCEL_TAB, plan.append);
  return { queued: true, already: false };
}

/**
 * Microsoft: the domain has lost more than its share of inboxes to the rules,
 * so it is cancelled the way the old automation cancelled a domain. The
 * inboxes still getting replies stay; every other one is stopped — at once —
 * and deleted, now or once confirmed; the domain goes Not Active and its
 * tenant onto 🚯 Tenants to Cancel.
 */
export async function cancelMicrosoftDomain(domain: string): Promise<void> {
  await loadOnce();
  const d = domainState(domain);
  if (d.cancelling || d.cancelledAt !== undefined) return;
  d.cancelling = true;
  d.updatedAt = Date.now();
  await persistDomains();
  const apiKey = serverApiKey();
  try {
    if (!apiKey) throw new Error("PLUSVIBE_API_KEY is not set on the server");
    if (!d.workspaceId) throw new Error("no workspace is known for this domain");
    const settings = await loadSettings();

    // 1. Every Microsoft inbox still on the domain that isn't already blocked,
    //    and its last 14 days. A Google stray isn't on the tenant, so it stays.
    const blocked = new Set(blockedOn(domain));
    const inboxes = (await workspaceInboxes(apiKey, d.workspaceId, Date.now())).filter(
      (i) =>
        i.email.trim().toLowerCase().endsWith(`@${domain}`) &&
        !blocked.has(i.email.trim().toLowerCase()) &&
        bucketOf(i.provider) === "microsoft"
    );
    const window = { start: toApiDate(daysAgo(JUDGE_WINDOW_DAYS - 1)), end: toApiDate(new Date()) };
    const { rows } = inboxes.length > 0 ? await fetchInboxStats(apiKey, d.workspaceId, inboxes, window) : { rows: [] };
    const figuresOf = (i: Inbox) => {
      const r = rows.find((x) => x.id === i.id || x.email === i.email.trim().toLowerCase());
      return r ? { sent: r.sent, bounces: r.bounces ?? 0, contacted: r.contacted, replies: r.replies, oooReplies: r.oooReplies } : null;
    };
    const plan = planCancellation(
      inboxes.map((i) => ({ inbox: i, email: i.email.trim().toLowerCase(), figures: figuresOf(i) })),
      settings.cancelKeepReplyRate
    );
    d.keptInboxes = plan.keep.map((k) => ({ email: k.email, oooReplyRate: k.oooReplyRate }));
    d.cancelledInboxes = plan.cancel.map((c) => c.email);

    // 2. The rest are blocked with the domain: a record each — the inbox's own,
    //    if it was judged before — and stopped together.
    const now = Date.now();
    const jobs: BlockedInboxJob[] = plan.cancel.map((c) => {
      const prior = [...records.values()].filter((r) => r.email === c.email).sort((a, b) => b.createdAt - a.createdAt)[0];
      const history =
        prior?.verdict && prior.figures && prior.rates && prior.judgedAt
          ? [
              { at: prior.judgedAt, verdict: prior.verdict, sent: prior.figures.sent, bounceRate: prior.rates.bounceRate, oooReplyRate: prior.rates.oooReplyRate },
              ...(prior.history ?? []),
            ].slice(0, MAX_INBOX_HISTORY)
          : prior?.history;
      const job: BlockedInboxJob = {
        id: prior?.id ?? randomUUID(),
        email: c.email,
        domain,
        status: "working",
        createdAt: prior?.createdAt ?? now,
        updatedAt: now,
        judgedAt: now,
        source: prior?.source ?? "domain-cancel",
        bounceReason: prior?.bounceReason,
        duplicateHits: prior?.duplicateHits ?? 0,
        ...(history ? { history } : {}),
        workspaceId: d.workspaceId,
        workspaceName: d.workspaceName,
        accountId: c.inbox.id,
        provider: "microsoft",
        providerRaw: c.inbox.provider,
        window,
        ...(c.figures ? { figures: c.figures, rates: ratesOf(c.figures) } : {}),
        verdict: "block",
        tier: "domain cancelled",
        rule: `kept only at an OOO reply rate of ${settings.cancelKeepReplyRate}% or more`,
        reasons: [
          `${domain} was cancelled after ${d.deletedByRules} of its inboxes were deleted, and this one's OOO reply rate ${
            c.oooReplyRate === null ? "could not be read" : `is ${c.oooReplyRate}%, under the ${settings.cancelKeepReplyRate}% keep bar`
          }`,
        ],
        blockedAt: now,
        cancelledWithDomain: true,
        errors: [],
      };
      records.set(job.id, job);
      return job;
    });
    if (jobs.length > 0) {
      try {
        const q = await quarantineInboxes(apiKey, d.workspaceId, jobs.map((j) => j.accountId!));
        for (const j of jobs) {
          j.sendingStopped = q.sendingStopped;
          j.warmupStopped = q.warmupStopped;
          for (const e of q.errors) pushError(j, `Could not stop ${e}`);
        }
      } catch (err) {
        for (const j of jobs) pushError(j, `Could not stop sending and warmup: ${msg(err)}`);
      }
      for (const j of jobs) {
        j.status = "awaiting_confirmation";
        await persist(j.id);
      }
    }

    // 3. The domain: Not Active, and its tenant queued to cancel.
    try {
      const r = await setDomainNotActive(domain);
      if (r.error) domainError(d, `Could not set ${domain} Not Active: ${r.error}`);
      else {
        d.notActiveAt = Date.now();
        d.notActiveReason = "microsoft-cancelled";
        d.previousStatus = r.previousStatus;
      }
      if (r.tenantEmail) {
        d.tenantEmail = r.tenantEmail;
        const t = await queueTenant(domain, r.tenantEmail, r.tenantSource ?? "");
        d.tenantQueued = t.queued;
        d.tenantAlreadyQueued = t.already;
        if (t.error) domainError(d, `Could not queue the tenant on "${CANCEL_TAB}": ${t.error}`);
      } else if (!r.error) {
        domainError(d, `${domain} has no ${COL_TENANT_EMAIL} in the sheet, so no tenant was queued to cancel.`);
      }
    } catch (err) {
      domainError(d, `Sheet update failed: ${msg(err)}`);
    }
    d.cancelledAt = Date.now();
    d.cancelling = false;
    d.updatedAt = Date.now();
    await persistDomains();

    // 4. Delete them — now, or when someone confirms, like any blocked inbox.
    if (settings.autoDelete) {
      for (const j of jobs) {
        j.autoDeleted = true;
        j.confirmedAt = Date.now();
        await runDelete(j.id);
      }
    }
  } catch (err) {
    d.cancelling = false;
    domainError(d, `Could not cancel ${domain}: ${msg(err)}`);
    d.updatedAt = Date.now();
    await persistDomains();
  }
}

// --- Control ---------------------------------------------------------------

export async function listInboxJobs(): Promise<BlockedInboxJob[]> {
  await loadOnce();
  return [...records.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export async function listInboxDomains(): Promise<InboxDomainState[]> {
  await loadOnce();
  return [...domains.values()].sort((a, b) => b.updatedAt - a.updatedAt);
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
  shared.queue = shared.queue.filter((q) => q.id !== id);
  try {
    await fs.unlink(fileFor(id));
  } catch {
    // already gone
  }
  return true;
}
