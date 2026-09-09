import "server-only";

import { randomUUID } from "crypto";
import { promises as fs, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { onShutdownFlush } from "@/lib/jobs/shutdown";
import {
  appendRow,
  appendRows,
  batchUpdateCells,
  columnLetter,
  envSpreadsheetId,
  isSheetWritingConfigured,
  quoteTab,
  readTab,
} from "@/lib/google-sheets";
import {
  DEFAULT_SHEET_TAB,
  COL_DOMAIN,
  COL_STATUS,
  COL_TENANT_EMAIL,
  COL_TENANT_SOURCE,
} from "@/lib/jobs/azure-warmup-types";
import { normalizeDomain, inboxIsOnDomain } from "@/lib/blocked-domains/domain";
import { COL_CANCEL_SOURCE } from "@/lib/blocked-domains/sheet-plan";
import {
  BLOCKED_STATUS,
  CANCEL_TAB,
  COL_CANCEL_TENANT,
  COL_DOMAIN_HOST,
  COL_GOOGLE_EMAIL,
  GOOGLE_CANCEL_TAB,
  buildCancelRow,
  buildGoogleCancelRow,
  findDomainRow,
  googleInboxesToQueue,
  headerIndex,
  isGoogleDomain,
  matchWorkspaceByClient,
  tenantAlreadyQueued,
} from "@/lib/blocked-domains/sheet-plan";
import { loadSettings } from "@/lib/blocked-domains/settings";
import {
  deleteInbox,
  fetchInboxStats,
  isSending,
  listInboxes,
  listWorkspaces,
  quarantineInboxes,
  resumeInboxes,
  type Inbox,
} from "@/lib/blocked-domains/api";
import {
  normalizeLimit,
  planRejudge,
  rejudgeWindow,
  suggestLimit,
} from "@/lib/blocked-domains/rejudge";
import { wasWrittenOff } from "@/lib/blocked-domains/stats";
import {
  aggregateDomain,
  indexStats,
  planQuarantine,
  stopEverything,
  unknownDomain,
  type QuarantinePlan,
} from "@/lib/blocked-domains/performance";
import {
  canRecheck,
  endOfTheLine,
  isRecheckDue,
  nextRunAt,
  startRecheck,
} from "@/lib/blocked-domains/recheck";
import { countProviders } from "@/lib/plusvibe-providers";
import { daysAgo, toApiDate } from "@/lib/format";
import type {
  BlockedDomainJob,
  PerformanceOutcome,
  PhaseState,
  RecheckRun,
  RejudgedInbox,
  SheetOutcome,
} from "@/lib/jobs/blocked-domains-types";
import { MAX_RECHECK_RUNS, MAX_STORED_ERRORS } from "@/lib/jobs/blocked-domains-types";

// Server-side manager for the Blocked Domains automation.
//
// Unlike the interactive tools, this is driven by a webhook with no browser
// attached, so the records are NOT scoped by the caller's API key — there is
// one shared log, and the UI reads all of it. The key comes from the
// environment (PLUSVIBE_API_KEY) and is never stored on a record.
//
// The "Client" column in the sheet usually names the workspace, which turns a
// scan of every workspace into a single lookup. It isn't always filled in, so
// it's a hint: the run still confirms the domain's inboxes are actually there,
// and falls back to scanning when they aren't.

const JOBS_BASE = process.env.JOBS_DIR || path.join(process.cwd(), ".jobs-data");
const JOBS_DIR = path.join(JOBS_BASE, "blocked-domains");
const RECORDS_DIR = path.join(JOBS_DIR, "records");

// Deduplication is PERMANENT, not windowed. An Azure setup can have 50 inboxes
// on one domain, so a single block produces bounces for weeks — any expiring
// window eventually lets a second run through, and by then the inboxes are
// already gone, so it would scan every workspace to find nothing and try to
// rewrite the sheet.
//
// A domain is therefore handled once, ever. Removing its record from the log is
// what re-arms it, which makes re-running a deliberate act rather than
// something that happens on its own after enough time passes.

const records = new Map<string, BlockedDomainJob>();
/** Memory-only: the inboxes that were stopped, so confirming doesn't re-scan. */
const quarantinedInboxes = new Map<string, Inbox[]>();
let loaded = false;

export function serverApiKey(): string | null {
  return process.env.PLUSVIBE_API_KEY?.trim() || null;
}

// --- Persistence -----------------------------------------------------------

function fileFor(id: string) {
  return path.join(RECORDS_DIR, `${id}.json`);
}

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

function flushRunningSync() {
  const live = [...records.values()].filter(
    (r) => r.status === "working" || r.status === "deleting"
  );
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
}

onShutdownFlush(flushRunningSync);

/** Defaults every field the UI iterates, so an old record can't blank the page. */
function migrateRecord(raw: BlockedDomainJob): BlockedDomainJob {
  const rec = raw;
  rec.errors = Array.isArray(rec.errors) ? rec.errors : [];
  rec.duplicateHits = typeof rec.duplicateHits === "number" ? rec.duplicateHits : 0;
  rec.inboxesFound = rec.inboxesFound ?? 0;
  rec.inboxesQuarantined = rec.inboxesQuarantined ?? 0;
  rec.inboxesDeleted = rec.inboxesDeleted ?? 0;
  rec.source = rec.source || "clay";
  const ps = (rec.phaseStates ?? {}) as Record<string, PhaseState>;
  rec.phaseStates = {
    locating: ps.locating ?? "pending",
    // Records written before the performance check existed have no state for
    // it; they stopped everything, which is what "skipped" says here.
    assessing: ps.assessing ?? (ps.locating === "done" ? "skipped" : "pending"),
    quarantining: ps.quarantining ?? "pending",
    deleting: ps.deleting ?? "pending",
    sheet: ps.sheet ?? "pending",
  };
  rec.createdAt = rec.createdAt || Date.now();
  rec.updatedAt = rec.updatedAt || rec.createdAt;
  return rec;
}

async function loadOnce() {
  if (loaded) return;
  loaded = true;
  try {
    await fs.mkdir(RECORDS_DIR, { recursive: true });
    for (const f of await fs.readdir(RECORDS_DIR)) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(RECORDS_DIR, f), "utf8");
        const parsed = JSON.parse(raw) as BlockedDomainJob;
        // A run interrupted mid-flight can't be resumed — its inbox list was
        // memory-only — but the record still says what happened.
        if (parsed.status === "working" || parsed.status === "deleting") {
          parsed.status = "interrupted";
        }
        // Quarantined-but-unconfirmed survives a restart as a record, but the
        // inbox list is gone, so confirming re-scans. Marked so the UI can say
        // so rather than showing a Delete button that silently does nothing.
        records.set(parsed.id, migrateRecord(parsed));
      } catch {
        // skip corrupt record
      }
    }
  } catch {
    // nothing to load
  }
}

// --- Intake ----------------------------------------------------------------

export type IntakeResult =
  | { outcome: "accepted"; job: BlockedDomainJob }
  | { outcome: "duplicate"; job: BlockedDomainJob }
  | { outcome: "invalid"; reason: string };

/**
 * Records a blocked domain and starts handling it.
 *
 * One blocked domain produces many bounce rows in Clay, so repeat hits are
 * expected and must be cheap: an in-flight or recently-handled domain records
 * the hit and returns, rather than scanning and deleting a second time.
 */
export async function intake(args: {
  domain: unknown;
  bounceReason?: string;
  source?: string;
}): Promise<IntakeResult> {
  await loadOnce();

  const domain = normalizeDomain(args.domain);
  if (!domain) {
    return {
      outcome: "invalid",
      reason: `"${String(args.domain ?? "")}" is not a readable domain`,
    };
  }

  const now = Date.now();
  // A re-armed record stays in the log but no longer blocks: history and the
  // once-per-domain guard are separate things.
  const existing = [...records.values()]
    .filter((r) => r.domain === domain && !r.rearmedAt)
    .sort((a, b) => b.createdAt - a.createdAt)[0];

  if (existing) {
    existing.duplicateHits += 1;
    existing.lastDuplicateAt = now;
    existing.updatedAt = now;
    await persist(existing.id);
    return { outcome: "duplicate", job: existing };
  }

  const rec: BlockedDomainJob = {
    id: randomUUID(),
    domain,
    status: "working",
    phase: "locating",
    phaseStates: {
      locating: "running",
      assessing: "pending",
      quarantining: "pending",
      deleting: "pending",
      sheet: "pending",
    },
    createdAt: now,
    updatedAt: now,
    bounceReason: args.bounceReason?.slice(0, 500) || undefined,
    source: args.source || "clay",
    duplicateHits: 0,
    inboxesFound: 0,
    inboxesQuarantined: 0,
    inboxesDeleted: 0,
    errors: [],
  };
  records.set(rec.id, rec);
  await persist(rec.id);
  void runLocateAndQuarantine(rec.id);
  return { outcome: "accepted", job: rec };
}

// --- Runner ----------------------------------------------------------------

function msg(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

function pushError(rec: BlockedDomainJob, text: string) {
  if (rec.errors.length < MAX_STORED_ERRORS) rec.errors.push(text);
  else rec.errorsTruncated = true;
}

/**
 * Phases 1 and 2: find the inboxes and stop them sending.
 *
 * Runs without confirmation. A blocked domain is actively burning the client's
 * reputation, and everything here is reversible — the daily limit goes back up
 * and warmup switches on again. Only deletion waits for a person.
 */
async function runLocateAndQuarantine(id: string) {
  const rec = records.get(id);
  if (!rec) return;
  const apiKey = serverApiKey();
  if (!apiKey) {
    rec.status = "error";
    rec.phaseStates.locating = "error";
    rec.phase = "finished";
    pushError(
      rec,
      "PLUSVIBE_API_KEY is not set on the server, so the webhook has no key to work with."
    );
    await persist(id);
    return;
  }

  try {
    // --- Phase 1: locate --------------------------------------------------
    const { workspaceId, workspaceName, inboxes, viaSheet, scanned, client, domainHost } =
      await locate(apiKey, rec);

    rec.workspaceId = workspaceId ?? undefined;
    rec.workspaceName = workspaceName ?? undefined;
    rec.foundViaSheet = viaSheet;
    rec.workspacesScanned = scanned;
    rec.inboxesFound = inboxes.length;
    rec.inboxesActive = inboxes.filter(isSending).length;
    rec.providers = countProviders(inboxes);
    if (client || domainHost) {
      rec.sheet = { ...(rec.sheet ?? emptySheet()), client, domainHost };
    }
    rec.phaseStates.locating = "done";
    rec.updatedAt = Date.now();
    await persist(id);

    if (inboxes.length === 0) {
      // Nothing to stop or delete, but the sheet still needs updating — the
      // domain is blocked whether or not Plusvibe still holds inboxes for it.
      rec.phaseStates.assessing = "skipped";
      rec.phaseStates.quarantining = "skipped";
      rec.phaseStates.deleting = "skipped";
      pushError(
        rec,
        `No inboxes found for ${rec.domain} in any workspace. The sheet is still updated.`
      );
      await persist(id);
      await runSheet(rec);
      finish(rec);
      await persist(id);
      return;
    }

    // --- Phase 2: assess --------------------------------------------------
    // Which of these inboxes actually have to stop. An inbox still getting
    // replies keeps sending, and is left out of the deletion too.
    rec.phase = "assessing";
    rec.phaseStates.assessing = "running";
    await persist(id);
    const settings = await loadSettings();
    const plan = await assess(apiKey, rec, workspaceId!, inboxes, settings);
    quarantinedInboxes.set(id, plan.stop);
    rec.inboxesKept = plan.keep.length;
    rec.quarantinedEmails = plan.stop.map((i) => i.email.trim().toLowerCase());
    rec.updatedAt = Date.now();
    await persist(id);

    // --- Phase 3: quarantine ---------------------------------------------
    // The under-performing inboxes are stopped whatever the domain is doing:
    // a mailbox that isn't replying shouldn't keep sending from a blocked
    // domain, even one worth keeping.
    if (plan.stop.length === 0) {
      rec.phaseStates.quarantining = "skipped";
    } else {
      rec.phase = "quarantining";
      rec.phaseStates.quarantining = "running";
      await persist(id);
      try {
        const q = await quarantineInboxes(
          apiKey,
          workspaceId!,
          plan.stop.map((i) => i.id)
        );
        rec.sendingStopped = q.sendingStopped;
        rec.warmupStopped = q.warmupStopped;
        // Only count inboxes as quarantined when BOTH halves landed. Claiming
        // they're stopped while warmup is still running is worse than saying
        // nothing — it's the sentence someone reads before deciding not to go
        // and check Plusvibe.
        rec.inboxesQuarantined =
          q.sendingStopped && q.warmupStopped ? plan.stop.length : 0;
        if (q.sendingStopped) {
          rec.inboxesActive = Math.max(0, (rec.inboxesActive ?? inboxes.length) - plan.stop.length);
        }
        for (const e of q.errors) {
          pushError(rec, `Could not stop ${e}`);
        }
        rec.phaseStates.quarantining =
          q.sendingStopped && q.warmupStopped ? "done" : "error";
      } catch (err) {
        rec.phaseStates.quarantining = "error";
        pushError(rec, `Could not stop sending/warmup: ${msg(err)}`);
      }
      rec.updatedAt = Date.now();
      await persist(id);
    }

    // --- The domain itself ------------------------------------------------
    // A domain still replying above its own bar is NOT written off: the
    // Domains tab keeps its status, the tenant is not queued for
    // cancellation, and nothing is deleted. Its weak inboxes are stopped
    // above, which is reversible; writing the domain off is not.
    if (isGoogleDomain(rec.providers)) {
      // Google Workspace has no tenant to cancel — each inbox is its own
      // seat. The burned inboxes are listed one by one, and the domain is
      // written off only once every inbox on it is burned; until then it is
      // kept and watched, whatever its own rate says.
      const allBurned = plan.keep.length === 0;
      await runSheetGoogle(rec, { burned: rec.quarantinedEmails ?? [], allBurned });
      rec.updatedAt = Date.now();
      await persist(id);
      if (!allBurned) {
        rec.phaseStates.deleting = "skipped";
        rec.status = "kept";
        rec.phase = "finished";
        if (!(await autoDeleteStopped(rec, settings))) await scheduleRecheck(rec);
        rec.updatedAt = Date.now();
        await persist(id);
        return;
      }
    } else if (rec.performance?.domain?.verdict === "performing") {
      rec.phaseStates.sheet = "skipped";
      rec.phaseStates.deleting = "skipped";
      rec.status = "kept";
      rec.phase = "finished";
      // A kept domain is exactly the case worth watching: it is flagged, and
      // its inboxes are the likeliest to fall under the bar next week.
      if (!(await autoDeleteStopped(rec, settings))) await scheduleRecheck(rec);
      rec.updatedAt = Date.now();
      await persist(id);
      return;
    } else {
      // --- Phase 4: the sheet --------------------------------------------
      // Written immediately, not on confirmation. The domain is under its
      // bar and its weak inboxes are already stopped, so "Not Active" is
      // simply true — and the tenant needs cancelling either way. Only the
      // irreversible deletion is worth making someone press a button for.
      await runSheet(rec);
      rec.updatedAt = Date.now();
      await persist(id);
    }

    if (plan.stop.length === 0) {
      // Under the bar as a domain, but every individual inbox is above it —
      // possible when a few small mailboxes carry the average down. The
      // domain is written off; there is nothing to stop or delete.
      rec.phaseStates.deleting = "skipped";
      finish(rec);
      await scheduleRecheck(rec);
      await persist(id);
      return;
    }

    // --- Hand off to deletion, or wait ------------------------------------
    if (settings.autoDelete) {
      rec.autoDeleted = true;
      rec.confirmedAt = Date.now();
      await persist(id);
      await runDelete(id);
    } else {
      rec.status = "awaiting_confirmation";
      // Only the deletion waits now — the sheet is already written.
      rec.phase = "deleting";
      rec.phaseStates.deleting = "waiting";
      // The inboxes that were left sending still deserve watching, whether or
      // not anyone gets round to confirming the deletion.
      await scheduleRecheck(rec);
      rec.updatedAt = Date.now();
      await persist(id);
    }
  } catch (err) {
    rec.status = "error";
    if (rec.phase !== "finished" && rec.phaseStates[rec.phase] === "running") {
      rec.phaseStates[rec.phase] = "error";
    }
    pushError(rec, msg(err));
    rec.phase = "finished";
    rec.updatedAt = Date.now();
    await persist(id);
  }
}

function emptySheet(): SheetOutcome {
  return { statusUpdated: false, tenantQueued: false };
}

/**
 * With Auto-delete on, every inbox the automation stops is deleted as soon as
 * it is stopped — on the first pass and on every repeat check, kept domains
 * included. This is that hand-off for the paths that don't write the domain
 * off (those hand off to deletion themselves).
 *
 * A domain someone chose to keep ("Keep them") is left alone: that was a
 * decision about its inboxes, and a later check must not quietly reverse it.
 * A kept domain stays kept afterwards — losing its dead inboxes is not a
 * write-off. Returns true when a deletion ran, in which case the schedule has
 * already been dealt with.
 */
async function autoDeleteStopped(
  rec: BlockedDomainJob,
  settings: { autoDelete: boolean }
): Promise<boolean> {
  if (!settings.autoDelete) return false;
  if ((rec.quarantinedEmails ?? []).length === 0) return false;
  if (rec.status === "dismissed" || rec.status === "error") return false;
  // runDelete runs the sheet step first when it hasn't happened, which would
  // be a write-off; a run that never got that far is not auto-cleaned.
  if (rec.phaseStates.sheet === "pending" || rec.phaseStates.sheet === "waiting") return false;

  const wasKept = rec.status === "kept";
  const errorsBefore = rec.errors.length;
  rec.autoDeleted = true;
  rec.confirmedAt = Date.now();
  await runDelete(rec.id);
  if (wasKept && rec.errors.length === errorsBefore) {
    rec.status = "kept";
    rec.phase = "finished";
    await persist(rec.id);
  }
  return true;
}

/**
 * The Google path of the sheet step.
 *
 * Every burned inbox goes onto 🛑 Google Inboxes to Cancel as its own row,
 * with the source from the domain's row in 📋 Domains. The domain's Status is
 * set to Not Active only when every inbox on it is burned; a domain with
 * anything still sending keeps its row as it was. 🚯 Tenants to Cancel is
 * never touched — there is no tenant.
 *
 * Idempotent: an inbox already on the tab is not listed again, which matters
 * because the same burned inboxes come back through here on every repeat
 * check.
 */
async function runSheetGoogle(
  rec: BlockedDomainJob,
  args: { burned: string[]; allBurned: boolean }
) {
  rec.phase = "sheet";
  rec.phaseStates.sheet = "running";
  const outcome: SheetOutcome = { ...(rec.sheet ?? emptySheet()), googlePath: true };
  rec.sheet = outcome;

  const sheetId = envSpreadsheetId();
  if (!sheetId) {
    outcome.error = "SPREADSHEET_ID is not set, so the sheet was left alone.";
    rec.phaseStates.sheet = "skipped";
    pushError(rec, outcome.error);
    return;
  }
  if (!isSheetWritingConfigured()) {
    outcome.error =
      "No Google service account configured, so the sheet was left alone.";
    rec.phaseStates.sheet = "skipped";
    pushError(rec, outcome.error);
    return;
  }

  try {
    // --- the domain's row ------------------------------------------------
    const grid = await readTab(sheetId, DEFAULT_SHEET_TAB);
    const header = grid[0] ?? [];
    const iStatus = headerIndex(header, COL_STATUS);
    const hit = findDomainRow(grid, rec.domain, {
      domain: headerIndex(header, COL_DOMAIN),
      status: iStatus,
      tenantEmail: headerIndex(header, COL_TENANT_EMAIL),
      tenantSource: headerIndex(header, COL_TENANT_SOURCE),
      client: headerIndex(header, "Client"),
      domainHost: headerIndex(header, COL_DOMAIN_HOST),
    });

    let source = "";
    if (!hit.row) {
      // Not fatal on this path: the inboxes are the thing worth listing, and
      // they can be listed without a source.
      pushError(
        rec,
        `${rec.domain} isn't in the "${DEFAULT_SHEET_TAB}" tab, so its status was left alone and its inboxes are listed without a source.`
      );
    } else {
      if (hit.matches > 1) {
        pushError(
          rec,
          `${rec.domain} appears ${hit.matches} times in "${DEFAULT_SHEET_TAB}" — only row ${hit.row.rowNumber} was used.`
        );
      }
      outcome.domainRow = hit.row.rowNumber;
      outcome.previousStatus = hit.row.currentStatus;
      outcome.tenantEmail = hit.row.tenantEmail || undefined;
      outcome.tenantSource = hit.row.tenantSource || undefined;
      outcome.client = hit.row.client || outcome.client;
      outcome.domainHost = hit.row.domainHost || outcome.domainHost;
      source = hit.row.tenantSource;

      if (args.allBurned) {
        if (iStatus < 0) {
          pushError(rec, `The "${DEFAULT_SHEET_TAB}" tab has no ${COL_STATUS} column.`);
        } else {
          await batchUpdateCells(sheetId, [
            {
              range: `${quoteTab(DEFAULT_SHEET_TAB)}!${columnLetter(iStatus)}${hit.row.rowNumber}`,
              value: BLOCKED_STATUS,
            },
          ]);
          outcome.statusUpdated = true;
        }
      }
    }

    // --- the inboxes -----------------------------------------------------
    if (args.burned.length > 0) {
      const gGrid = await readTab(sheetId, GOOGLE_CANCEL_TAB);
      const gHeader = gGrid[0] ?? [COL_GOOGLE_EMAIL, COL_CANCEL_SOURCE];
      const iEmail = headerIndex(gHeader, COL_GOOGLE_EMAIL);
      if (iEmail < 0) {
        // Writing rows the tab can't place would put addresses under the
        // wrong heading, which is worse than listing nothing and saying so.
        outcome.error = `The "${GOOGLE_CANCEL_TAB}" tab has no ${COL_GOOGLE_EMAIL} column, so no inboxes were listed there.`;
        rec.phaseStates.sheet = "error";
        pushError(rec, outcome.error);
      } else {
        const { toQueue, alreadyQueued } = googleInboxesToQueue(gGrid, iEmail, args.burned);
        if (toQueue.length > 0) {
          await appendRows(
            sheetId,
            GOOGLE_CANCEL_TAB,
            toQueue.map((email) => buildGoogleCancelRow(gHeader, { email, source }))
          );
        }
        outcome.googleQueued = [...(outcome.googleQueued ?? []), ...toQueue];
        outcome.googleAlreadyQueued = alreadyQueued;
      }
    }

    if (rec.phaseStates.sheet === "running") rec.phaseStates.sheet = "done";
  } catch (err) {
    outcome.error = msg(err);
    rec.phaseStates.sheet = "error";
    pushError(rec, `Sheet update failed: ${msg(err)}`);
  }
}

/** The window the inboxes are judged on: the last 7 days, ending today. */
export function performanceWindow(): { start: string; end: string } {
  return { start: toApiDate(daysAgo(6)), end: toApiDate(new Date()) };
}

/**
 * Reads the domain's inboxes' last 7 days and decides which have to stop.
 *
 * Every failure path stops everything. The domain is blocked, so an inbox
 * keeping its daily limit is the exception that needs evidence — no stats
 * means no evidence, not the benefit of the doubt.
 */
async function assess(
  apiKey: string,
  rec: BlockedDomainJob,
  workspaceId: string,
  inboxes: Inbox[],
  settings: { checkPerformance: boolean; minReplyRateOoo: number; minDomainReplyRateOoo: number }
): Promise<QuarantinePlan> {
  const window = performanceWindow();
  const outcome: PerformanceOutcome = {
    ...window,
    threshold: settings.minReplyRateOoo,
    domainThreshold: settings.minDomainReplyRateOoo,
    source: "skipped",
    inboxes: [],
  };

  if (!settings.checkPerformance) {
    const plan = stopEverything(inboxes);
    outcome.note = "The performance check is off, so the domain is cancelled and every inbox on it stopped.";
    outcome.inboxes = plan.assessments;
    outcome.domain = unknownDomain(inboxes.length);
    rec.performance = outcome;
    rec.phaseStates.assessing = "skipped";
    return plan;
  }

  let plan: QuarantinePlan;
  try {
    const { rows, source, errors } = await fetchInboxStats(apiKey, workspaceId, inboxes, window);
    outcome.source = source;
    for (const e of errors) pushError(rec, e);
    if (rows.length === 0 && inboxes.length > 0) {
      // Nothing came back at all — treat it as an outage, not as "no replies".
      plan = stopEverything(inboxes);
      outcome.source = "unavailable";
      outcome.domain = unknownDomain(inboxes.length);
      outcome.note = "No figures came back for these inboxes, so the domain was cancelled and all of them stopped.";
      pushError(rec, "Could not read the last 7 days for any inbox on this domain; all of them were stopped.");
    } else {
      plan = planQuarantine(inboxes, indexStats(rows), settings.minReplyRateOoo);
      outcome.domain = aggregateDomain(rows, settings.minDomainReplyRateOoo);
    }
    rec.phaseStates.assessing = "done";
  } catch (err) {
    plan = stopEverything(inboxes);
    outcome.source = "unavailable";
    outcome.domain = unknownDomain(inboxes.length);
    outcome.note = "The performance check failed, so the domain was cancelled and all inboxes stopped.";
    pushError(rec, `Could not check the last 7 days (${msg(err)}); all inboxes were stopped.`);
    rec.phaseStates.assessing = "error";
  }
  outcome.inboxes = plan.assessments;
  rec.performance = outcome;
  return plan;
}

function finish(rec: BlockedDomainJob) {
  rec.phase = "finished";
  rec.status = rec.errors.length > 0 ? "error" : "done";
  rec.updatedAt = Date.now();
}

interface LocateResult {
  workspaceId: string | null;
  workspaceName: string | null;
  inboxes: Inbox[];
  viaSheet: boolean;
  scanned: number;
  client?: string;
  domainHost?: string;
}

/**
 * Finds which workspace holds the domain's inboxes.
 *
 * Tries the sheet's Client column first, then scans. The scan stops at the
 * first workspace with a match — a sending domain belongs to one client, so
 * finding it twice would mean something is wrong upstream, not that both
 * should be deleted.
 */
async function locate(
  apiKey: string,
  rec: BlockedDomainJob
): Promise<LocateResult> {
  const workspaces = await listWorkspaces(apiKey);
  let client: string | undefined;
  let domainHost: string | undefined;
  let hinted: string | null = null;

  // The sheet is a hint only; a failure here costs speed, not correctness.
  try {
    const sheetId = envSpreadsheetId();
    if (sheetId) {
      const grid = await readTab(sheetId, DEFAULT_SHEET_TAB);
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
        client = hit.row.client || undefined;
        domainHost = hit.row.domainHost || undefined;
        if (client) hinted = matchWorkspaceByClient(client, workspaces);
      }
    }
  } catch (err) {
    pushError(rec, `Could not read the sheet for a workspace hint: ${msg(err)}`);
  }

  if (hinted) {
    const inboxes = (await listInboxes(apiKey, hinted)).filter((i) =>
      inboxIsOnDomain(i.email, rec.domain)
    );
    if (inboxes.length > 0) {
      return {
        workspaceId: hinted,
        workspaceName: workspaces.find((w) => w._id === hinted)?.name ?? null,
        inboxes,
        viaSheet: true,
        scanned: 1,
        client,
        domainHost,
      };
    }
  }

  // No usable hint, or the hint was wrong: look everywhere.
  let scanned = hinted ? 1 : 0;
  for (const ws of workspaces) {
    if (ws._id === hinted) continue;
    scanned++;
    const inboxes = (await listInboxes(apiKey, ws._id)).filter((i) =>
      inboxIsOnDomain(i.email, rec.domain)
    );
    if (inboxes.length > 0) {
      return {
        workspaceId: ws._id,
        workspaceName: ws.name,
        inboxes,
        viaSheet: false,
        scanned,
        client,
        domainHost,
      };
    }
  }

  return {
    workspaceId: null,
    workspaceName: null,
    inboxes: [],
    viaSheet: false,
    scanned,
    client,
    domainHost,
  };
}

/**
 * Deletes the inboxes, once someone has said so (or auto-delete is on).
 *
 * The sheet has normally already been written by the time this runs. The guard
 * below covers a record that was quarantined by an older build, where the
 * sheet used to wait for confirmation too — without it, confirming such a job
 * would delete the inboxes and never touch the sheet.
 */
async function runDelete(id: string) {
  const rec = records.get(id);
  if (!rec) return;
  const apiKey = serverApiKey();
  if (!apiKey || !rec.workspaceId) {
    rec.status = "error";
    pushError(rec, "No API key or workspace, so nothing was deleted.");
    rec.phase = "finished";
    await persist(id);
    return;
  }

  rec.status = "deleting";
  if (
    rec.phaseStates.sheet === "pending" ||
    rec.phaseStates.sheet === "waiting"
  ) {
    await runSheet(rec);
    rec.updatedAt = Date.now();
    await persist(id);
  }

  rec.phase = "deleting";
  rec.phaseStates.deleting = "running";
  rec.updatedAt = Date.now();
  await persist(id);

  // The inbox list is memory-only, so a restart between quarantine and confirm
  // means re-finding them rather than deleting nothing. Only the inboxes that
  // were actually stopped are deleted — one left sending because it is still
  // replying must not be swept up by the re-read.
  let inboxes = quarantinedInboxes.get(id);
  if (!inboxes) {
    try {
      const onDomain = (await listInboxes(apiKey, rec.workspaceId)).filter((i) =>
        inboxIsOnDomain(i.email, rec.domain)
      );
      const stopped = rec.quarantinedEmails;
      inboxes = stopped
        ? onDomain.filter((i) => stopped.includes(i.email.trim().toLowerCase()) || stopped.includes(i.email))
        : onDomain;
    } catch (err) {
      rec.phaseStates.deleting = "error";
      pushError(rec, `Could not re-read the inboxes: ${msg(err)}`);
      inboxes = [];
    }
  }

  const gone = new Set<string>();
  const deletedBefore = rec.inboxesDeleted;
  for (const inbox of inboxes) {
    try {
      await deleteInbox(apiKey, rec.workspaceId, inbox.email);
      rec.inboxesDeleted += 1;
      gone.add(lower(inbox.email));
    } catch (err) {
      pushError(rec, `${inbox.email}: ${msg(err)}`);
    }
    if (rec.inboxesDeleted % 10 === 0) {
      rec.updatedAt = Date.now();
      await persist(id);
    }
  }
  quarantinedInboxes.delete(id);
  // The quarantined list is "stopped and still there": what was deleted
  // leaves it, so nothing offers to delete it a second time.
  rec.quarantinedEmails = (rec.quarantinedEmails ?? []).filter((e) => !gone.has(lower(e)));
  // `inboxesFound` means "on the domain as of the last look", so the ones just
  // deleted are no longer among them. THIS run's count, not the record's
  // total: a record can delete more than once (a kept domain's stragglers,
  // Auto-delete on a repeat check), and subtracting the total again would
  // count the earlier deletions twice.
  const deletedNow = rec.inboxesDeleted - deletedBefore;
  rec.inboxesFound = Math.max(0, rec.inboxesFound - deletedNow);
  rec.phaseStates.deleting = deletedNow === inboxes.length ? "done" : "error";

  finish(rec);
  // Inboxes that were kept are still sending, so the domain stays watched;
  // if the deletion took the last one, scheduleRecheck ends the schedule.
  await scheduleRecheck(rec);
  await persist(id);
}

/**
 * Phase 5: 📋 Domains status → Not Active, and the tenant onto
 * 🚯 Tenants to Cancel.
 *
 * Sheet failures never fail the run — the inboxes are already gone, and a
 * missing sheet edit is a note to act on, not a reason to report the deletion
 * as unsuccessful.
 */
async function runSheet(rec: BlockedDomainJob) {
  rec.phase = "sheet";
  rec.phaseStates.sheet = "running";
  const outcome = { ...(rec.sheet ?? emptySheet()) };
  rec.sheet = outcome;

  const sheetId = envSpreadsheetId();
  if (!sheetId) {
    outcome.error = "SPREADSHEET_ID is not set, so the sheet was left alone.";
    rec.phaseStates.sheet = "skipped";
    pushError(rec, outcome.error);
    return;
  }
  if (!isSheetWritingConfigured()) {
    outcome.error =
      "No Google service account configured, so the sheet was left alone.";
    rec.phaseStates.sheet = "skipped";
    pushError(rec, outcome.error);
    return;
  }

  try {
    const grid = await readTab(sheetId, DEFAULT_SHEET_TAB);
    const header = grid[0] ?? [];
    const iStatus = headerIndex(header, COL_STATUS);
    const hit = findDomainRow(grid, rec.domain, {
      domain: headerIndex(header, COL_DOMAIN),
      status: iStatus,
      tenantEmail: headerIndex(header, COL_TENANT_EMAIL),
      tenantSource: headerIndex(header, COL_TENANT_SOURCE),
      client: headerIndex(header, "Client"),
      domainHost: headerIndex(header, COL_DOMAIN_HOST),
    });

    if (!hit.row) {
      outcome.error = `${rec.domain} isn't in the "${DEFAULT_SHEET_TAB}" tab, so nothing was updated there.`;
      rec.phaseStates.sheet = "error";
      pushError(rec, outcome.error);
      return;
    }
    if (hit.matches > 1) {
      pushError(
        rec,
        `${rec.domain} appears ${hit.matches} times in "${DEFAULT_SHEET_TAB}" — only row ${hit.row.rowNumber} was updated.`
      );
    }

    outcome.domainRow = hit.row.rowNumber;
    outcome.previousStatus = hit.row.currentStatus;
    outcome.tenantEmail = hit.row.tenantEmail || undefined;
    outcome.tenantSource = hit.row.tenantSource || undefined;
    outcome.client = hit.row.client || outcome.client;
    outcome.domainHost = hit.row.domainHost || outcome.domainHost;

    if (iStatus < 0) {
      pushError(rec, `The "${DEFAULT_SHEET_TAB}" tab has no ${COL_STATUS} column.`);
    } else {
      await batchUpdateCells(sheetId, [
        {
          range: `${quoteTab(DEFAULT_SHEET_TAB)}!${columnLetter(iStatus)}${hit.row.rowNumber}`,
          value: BLOCKED_STATUS,
        },
      ]);
      outcome.statusUpdated = true;
    }

    // --- the tenant ------------------------------------------------------
    // Deliberately independent of the status above. A domain that was already
    // "Not Active" still needs its tenant cancelled — the two columns record
    // different things, and a domain marked Not Active by hand is exactly the
    // case where the tenant is most likely to have been forgotten.
    if (!hit.row.tenantEmail) {
      pushError(
        rec,
        `${rec.domain} has no ${COL_TENANT_EMAIL} in the sheet, so nothing was added to "${CANCEL_TAB}".`
      );
    } else {
      const cancelGrid = await readTab(sheetId, CANCEL_TAB);
      const cancelHeader = cancelGrid[0] ?? [COL_CANCEL_TENANT];
      const iTenant = headerIndex(cancelHeader, COL_CANCEL_TENANT);
      if (tenantAlreadyQueued(cancelGrid, iTenant, hit.row.tenantEmail)) {
        outcome.tenantAlreadyQueued = true;
      } else {
        await appendRow(
          sheetId,
          CANCEL_TAB,
          buildCancelRow(cancelHeader, {
            tenant: hit.row.tenantEmail,
            source: hit.row.tenantSource,
          })
        );
        outcome.tenantQueued = true;
      }
    }

    if (rec.phaseStates.sheet === "running") rec.phaseStates.sheet = "done";
  } catch (err) {
    outcome.error = msg(err);
    rec.phaseStates.sheet = "error";
    pushError(rec, `Sheet update failed: ${msg(err)}`);
  }
}

// --- Repeat checks ---------------------------------------------------------
//
// A flagged domain is re-assessed on a schedule, because the mailboxes still
// replying today are the likeliest to fall under the bar next week. Each run
// applies the same two bars to fresh figures: newly weak inboxes are stopped,
// and a domain that has now fallen under its bar is written off.

const TICK_MS = 60_000;
let schedulerStarted = false;
/** Ids with a recheck in flight, so a slow run can't be started twice. */
const rechecking = new Set<string>();

export async function bootScheduler() {
  await loadOnce();
  if (schedulerStarted) return;
  schedulerStarted = true;
  const timer = setInterval(() => void tick(), TICK_MS);
  // Never keep the process alive just for this.
  timer.unref?.();
  // A check that came due while the process was down shouldn't wait a further
  // minute — on Railway the process is replaced on every deploy.
  void tick();
}

async function tick() {
  const now = Date.now();
  for (const [id, rec] of records) {
    if (!isRecheckDue(rec, now) || !canRecheck(rec)) continue;
    await runRecheck(id, "scheduled");
  }
}

/**
 * Reads the domain's registrar from the sheet onto the record.
 *
 * Best-effort: the host is context for whoever reads the card, so a sheet that
 * can't be read costs a line of detail, never the run.
 */
async function refreshDomainHost(rec: BlockedDomainJob) {
  try {
    const sheetId = envSpreadsheetId();
    if (!sheetId) return;
    const grid = await readTab(sheetId, DEFAULT_SHEET_TAB);
    const header = grid[0] ?? [];
    const hit = findDomainRow(grid, rec.domain, {
      domain: headerIndex(header, COL_DOMAIN),
      status: headerIndex(header, COL_STATUS),
      tenantEmail: headerIndex(header, COL_TENANT_EMAIL),
      tenantSource: headerIndex(header, COL_TENANT_SOURCE),
      client: headerIndex(header, "Client"),
      domainHost: headerIndex(header, COL_DOMAIN_HOST),
    });
    if (hit.row?.domainHost) {
      rec.sheet = { ...(rec.sheet ?? emptySheet()), domainHost: hit.row.domainHost };
    }
  } catch {
    // the card simply won't show a host
  }
}

/** Arms the repeat checks for a record, if there is anything left to watch. */
async function scheduleRecheck(rec: BlockedDomainJob) {
  const settings = await loadSettings();
  // `inboxesFound` is already net of deletions — runDelete takes them off as
  // it goes — so it is used as is. Subtracting the total deleted again, as
  // this once did, read a domain with survivors as empty after any deletion
  // and ended its schedule while inboxes were still sending.
  const end = endOfTheLine({
    inboxesFound: rec.inboxesFound,
    keptInboxes: rec.inboxesKept ?? 0,
    writtenOff: wasWrittenOff(rec),
  });
  const existing = rec.recheck;
  if (end.reason) {
    rec.recheck = {
      enabled: false,
      everyDays: existing?.everyDays ?? settings.recheckDays,
      runs: existing?.runs ?? [],
      endedReason: end.reason,
    };
    return;
  }
  rec.recheck = {
    enabled: settings.recheck,
    everyDays: settings.recheckDays,
    nextAt: settings.recheck ? nextRunAt(Date.now(), settings.recheckDays) : undefined,
    runs: existing?.runs ?? [],
    endedReason: settings.recheck ? undefined : "Repeat checks are switched off.",
  };
}

/**
 * One repeat assessment of an already-flagged domain.
 *
 * Everything it can do is additive: it stops inboxes that have fallen under
 * the bar since last time, and writes the domain off if it has fallen under
 * its own. It never un-stops an inbox, never restores a sheet status, and
 * never deletes anything on its own.
 */
export async function runRecheck(
  id: string,
  trigger: "scheduled" | "manual"
): Promise<boolean> {
  await loadOnce();
  const rec = records.get(id);
  if (!rec || !canRecheck(rec) || rechecking.has(id)) return false;
  const apiKey = serverApiKey();
  const state = rec.recheck;
  if (!state) return false;

  rechecking.add(id);
  const run: RecheckRun = { at: Date.now(), trigger, inboxesFound: 0, stopped: 0, kept: 0 };
  try {
    if (!apiKey) throw new Error("PLUSVIBE_API_KEY is not set on the server.");
    if (!rec.workspaceId) throw new Error("This run never found a workspace, so there is nothing to re-check.");
    const settings = await loadSettings();

    // What is still there. Inboxes deleted since last time simply aren't.
    const inboxes = (await listInboxes(apiKey, rec.workspaceId)).filter((i) =>
      inboxIsOnDomain(i.email, rec.domain)
    );
    run.inboxesFound = inboxes.length;
    rec.inboxesFound = inboxes.length;
    rec.inboxesActive = inboxes.filter(isSending).length;
    rec.providers = countProviders(inboxes);
    run.inboxesActive = rec.inboxesActive;

    if (inboxes.length === 0) {
      state.endedReason = "No inboxes left on this domain.";
      state.enabled = false;
      state.nextAt = undefined;
      run.kept = 0;
      return true;
    }

    // Backfills the host for records handled before it was read, and keeps it
    // honest if the sheet has been corrected since.
    await refreshDomainHost(rec);

    const plan = await assess(apiKey, rec, rec.workspaceId, inboxes, settings);
    const domain = rec.performance?.domain;
    run.domainReplyRateOoo = domain?.replyRateOoo;
    run.verdict = domain?.verdict;
    run.kept = plan.keep.length;
    rec.inboxesKept = plan.keep.length;

    // Only inboxes that weren't already stopped are worth a call.
    const already = new Set((rec.quarantinedEmails ?? []).map((e) => e.trim().toLowerCase()));
    const fresh = plan.stop.filter((i) => !already.has(i.email.trim().toLowerCase()));
    if (fresh.length > 0) {
      const q = await quarantineInboxes(apiKey, rec.workspaceId, fresh.map((i) => i.id));
      if (q.sendingStopped && q.warmupStopped) {
        run.stopped = fresh.length;
        rec.inboxesActive = Math.max(0, (rec.inboxesActive ?? fresh.length) - fresh.length);
        run.inboxesActive = rec.inboxesActive;
        rec.inboxesQuarantined += fresh.length;
        rec.sendingStopped = true;
        rec.warmupStopped = true;
      } else {
        for (const e of q.errors) pushError(rec, `Repeat check could not stop ${e}`);
        run.error = "Some inboxes could not be stopped.";
      }
    }
    rec.quarantinedEmails = plan.stop.map((i) => i.email.trim().toLowerCase());
    quarantinedInboxes.set(id, plan.stop);

    // A domain that has now fallen under its bar gets written off — once. On
    // the Google path the bar is "every inbox burned": each check lists the
    // newly burned ones, and the domain goes Not Active when none is left.
    // From the sheet outcome, not the status: a domain put back by Undo is
    // not written off, whatever else is going on with it.
    const alreadyWrittenOff = wasWrittenOff(rec);
    let wroteOff = false;
    if (!alreadyWrittenOff) {
      if (isGoogleDomain(rec.providers)) {
        const allBurned = plan.keep.length === 0;
        await runSheetGoogle(rec, { burned: rec.quarantinedEmails ?? [], allBurned });
        wroteOff = allBurned;
      } else if (domain?.verdict === "under") {
        await runSheet(rec);
        wroteOff = true;
      }
    }
    // Not the write-off moment, but with Auto-delete on, whatever is stopped
    // goes now — a kept domain's weak inboxes, a straggler on a domain whose
    // deletion is long done, or a deletion that was waiting when the setting
    // was switched on.
    if (!wroteOff && (await autoDeleteStopped(rec, settings))) {
      // runDelete has scheduled the next check, or ended the schedule.
      return true;
    }

    if (wroteOff) {
      run.wroteOff = true;
      if (plan.stop.length === 0) {
        // Written off with nothing stopped: nothing to delete.
        rec.status = "done";
        rec.phase = "finished";
        rec.phaseStates.deleting = "skipped";
      } else if (settings.autoDelete) {
        // The same hand-off the first pass makes. Marking the record done
        // here without deleting — which is what happened before — left the
        // stopped inboxes in Plusvibe with a log that said otherwise.
        rec.autoDeleted = true;
        rec.confirmedAt = Date.now();
        await persist(id);
        await runDelete(id);
        // runDelete schedules the next check, or ends the schedule, itself.
        return true;
      } else {
        rec.status = "awaiting_confirmation";
        rec.phase = "deleting";
        rec.phaseStates.deleting = "waiting";
      }
    }

    // Schedule the next one, or stop if there is nothing left to learn.
    const end = endOfTheLine({
      inboxesFound: inboxes.length,
      keptInboxes: plan.keep.length,
      writtenOff: wasWrittenOff(rec),
    });
    if (end.reason) {
      state.enabled = false;
      state.nextAt = undefined;
      state.endedReason = end.reason;
    } else {
      state.everyDays = settings.recheckDays;
      state.enabled = settings.recheck;
      state.nextAt = settings.recheck ? nextRunAt(Date.now(), settings.recheckDays) : undefined;
      state.endedReason = settings.recheck ? undefined : "Repeat checks are switched off.";
    }
    return true;
  } catch (err) {
    run.error = msg(err);
    pushError(rec, `Repeat check failed: ${run.error}`);
    // A failure doesn't end the schedule — the next one may well work.
    if (state.enabled) state.nextAt = nextRunAt(Date.now(), state.everyDays);
    return false;
  } finally {
    rechecking.delete(id);
    // The deletion hand-off can replace rec.recheck (scheduleRecheck ends the
    // schedule with a fresh object), so the run goes onto whatever is live.
    const live = rec.recheck ?? state;
    live.runs.unshift(run);
    if (live.runs.length > MAX_RECHECK_RUNS) live.runs.length = MAX_RECHECK_RUNS;
    rec.updatedAt = Date.now();
    await persist(id);
  }
}

/** Turns the repeat checks for one record on or off by hand. */
export async function setRecheck(id: string, enabled: boolean): Promise<boolean> {
  await loadOnce();
  const rec = records.get(id);
  if (!rec) return false;
  const settings = await loadSettings();
  const state = rec.recheck ?? startRecheck(Date.now(), settings.recheckDays, false);
  state.enabled = enabled;
  state.everyDays = state.everyDays || settings.recheckDays;
  state.nextAt = enabled ? nextRunAt(Date.now(), state.everyDays) : undefined;
  state.endedReason = enabled ? undefined : "Switched off for this domain.";
  rec.recheck = state;
  rec.updatedAt = Date.now();
  await persist(id);
  return true;
}

// --- Query / control -------------------------------------------------------

export async function listJobs(): Promise<BlockedDomainJob[]> {
  await loadOnce();
  return [...records.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export async function getJob(id: string): Promise<BlockedDomainJob | null> {
  await loadOnce();
  return records.get(id) ?? null;
}

/** Releases a quarantined domain for deletion. */
export async function confirmJob(id: string): Promise<boolean> {
  await loadOnce();
  const rec = records.get(id);
  if (!rec || rec.status !== "awaiting_confirmation") return false;
  rec.confirmedAt = Date.now();
  await persist(id);
  void runDelete(id);
  return true;
}

/**
 * Declines the deletion. The quarantine stays — whoever dismissed it decided
 * not to delete, not that the domain is fine to keep sending from.
 */
export async function dismissJob(id: string): Promise<boolean> {
  await loadOnce();
  const rec = records.get(id);
  if (!rec || rec.status !== "awaiting_confirmation") return false;
  rec.status = "dismissed";
  rec.phase = "finished";
  // The sheet has already been written — the domain is blocked and stopped
  // regardless of this choice. Only the deletion is declined.
  rec.phaseStates.deleting = "skipped";
  rec.updatedAt = Date.now();
  quarantinedInboxes.delete(id);
  await persist(id);
  return true;
}

/**
 * Lets a domain be handled again, without losing what happened last time.
 *
 * Only for records that have finished. Re-arming something still in flight or
 * awaiting confirmation would let a second run start alongside the first.
 */
// --- Re-judging ------------------------------------------------------------
//
// Records handled under earlier rules — the per-sent ratio, or before the
// provider was captured — carry decisions the current rules would not make.
// Re-judging reads a window that reaches back to before the domain was
// flagged, so inboxes stopped since still have their real sends in view, and
// applies the current rules to it. It decides nothing itself: Restore and
// Undo write-off are separate actions a person takes after seeing the figures.

const rejudging = new Set<string>();
let rejudgeAllState: { running: boolean; total: number; done: number; startedAt: number } | undefined;

export function rejudgeAllStatus() {
  return rejudgeAllState;
}

const lower = (s: string) => s.trim().toLowerCase();

export async function rejudgeJob(id: string): Promise<boolean> {
  await loadOnce();
  const rec = records.get(id);
  if (!rec || !canRecheck(rec) || rejudging.has(id)) return false;
  const apiKey = serverApiKey();
  if (!apiKey) {
    pushError(rec, "PLUSVIBE_API_KEY is not set, so the domain could not be re-judged.");
    await persist(id);
    return false;
  }
  rejudging.add(id);
  try {
    const settings = await loadSettings();

    // --- the inboxes, as they are now ------------------------------------
    let workspaceId = rec.workspaceId;
    if (!workspaceId) {
      const loc = await locate(apiKey, rec);
      if (!loc.workspaceId) {
        pushError(rec, `Could not find ${rec.domain}'s inboxes in any workspace, so it was not re-judged.`);
        await persist(id);
        return false;
      }
      workspaceId = loc.workspaceId;
      rec.workspaceId = workspaceId;
      rec.workspaceName = loc.workspaceName ?? undefined;
    }
    const all = await listInboxes(apiKey, workspaceId);
    const onDomain = all.filter((i) => inboxIsOnDomain(i.email, rec.domain));
    rec.inboxesFound = onDomain.length;
    rec.inboxesActive = onDomain.filter(isSending).length;
    rec.providers = countProviders(onDomain);
    await refreshDomainHost(rec);

    // --- the wider window --------------------------------------------------
    const w = rejudgeWindow(rec.createdAt, Date.now());
    const range = { start: toApiDate(new Date(w.start)), end: toApiDate(new Date(w.end)) };
    let source: "bulk" | "per-inbox" | "unavailable" = "unavailable";
    let rows: Awaited<ReturnType<typeof fetchInboxStats>>["rows"] = [];
    if (onDomain.length > 0) {
      const got = await fetchInboxStats(apiKey, workspaceId, onDomain, range);
      rows = got.rows;
      source = got.source;
      for (const e of got.errors) pushError(rec, e);
      if (rows.length === 0) source = "unavailable";
    }
    const plan = planQuarantine(onDomain, indexStats(rows), settings.minReplyRateOoo);
    const domain =
      rows.length > 0
        ? aggregateDomain(rows, settings.minDomainReplyRateOoo)
        : unknownDomain(onDomain.length);

    const stopped = new Set((rec.quarantinedEmails ?? []).map(lower));
    const byEmail = new Map(onDomain.map((i) => [lower(i.email), i]));
    const inboxes: RejudgedInbox[] = plan.assessments.map((a) => {
      const live = byEmail.get(lower(a.email));
      return {
        ...a,
        stoppedByUs: stopped.has(lower(a.email)),
        sendingNow: live ? isSending(live) : false,
      };
    });
    const googlePath = isGoogleDomain(rec.providers);
    const verdicts = planRejudge({ inboxes, domain, googlePath });

    rec.rejudge = {
      at: Date.now(),
      ...range,
      threshold: settings.minReplyRateOoo,
      domainThreshold: settings.minDomainReplyRateOoo,
      source,
      domain,
      inboxes,
      ...verdicts,
      googlePath,
      suggestedLimit: suggestLimit(all),
    };
    rec.updatedAt = Date.now();
    await persist(id);
    return true;
  } catch (err) {
    pushError(rec, `Re-judging failed: ${msg(err)}`);
    rec.updatedAt = Date.now();
    await persist(id);
    return false;
  } finally {
    rejudging.delete(id);
  }
}

/**
 * Re-judges every record that can be, one after another in the background.
 * Sequential on purpose: each one lists a whole workspace and reads stats,
 * and the rate limiter is shared with everything else the app is doing.
 */
export async function rejudgeAll(): Promise<{ started: boolean; total: number }> {
  await loadOnce();
  if (rejudgeAllState?.running) return { started: false, total: rejudgeAllState.total };
  const ids = [...records.values()]
    .filter((r) => canRecheck(r))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((r) => r.id);
  rejudgeAllState = { running: true, total: ids.length, done: 0, startedAt: Date.now() };
  void (async () => {
    for (const id of ids) {
      try {
        await rejudgeJob(id);
      } catch {
        // recorded on the job
      }
      if (rejudgeAllState) rejudgeAllState.done += 1;
    }
    if (rejudgeAllState) rejudgeAllState.running = false;
  })();
  return { started: true, total: ids.length };
}

/**
 * Turns the restorable inboxes back on at the given daily limit.
 *
 * Only ever the ones the last re-judgement marked restorable — stopped by
 * this automation, and clearing the bar on the wider window. The record is
 * brought back in line: they leave the quarantined list, so a later Delete
 * cannot take them, and the counts on the card follow.
 */
export async function restoreInboxes(
  id: string,
  rawLimit: unknown
): Promise<{ ok: boolean; restored: number; error?: string }> {
  await loadOnce();
  const rec = records.get(id);
  if (!rec || !canRecheck(rec)) return { ok: false, restored: 0, error: "Job not found, or mid-run." };
  const dailyLimit = normalizeLimit(rawLimit);
  if (dailyLimit === null) return { ok: false, restored: 0, error: "The daily limit must be a whole number from 1 to 500." };
  const r = rec.rejudge;
  if (!r || r.restorable.length === 0) {
    return { ok: false, restored: 0, error: "Nothing to restore — re-judge the domain first." };
  }
  const apiKey = serverApiKey();
  if (!apiKey || !rec.workspaceId) return { ok: false, restored: 0, error: "No API key or workspace." };

  const want = new Set(r.restorable.map(lower));
  const targets = r.inboxes.filter((i) => want.has(lower(i.email)));
  const q = await resumeInboxes(apiKey, rec.workspaceId, targets.map((i) => i.id), dailyLimit);
  const run = { at: Date.now(), emails: targets.map((i) => i.email), dailyLimit } as {
    at: number; emails: string[]; dailyLimit: number; error?: string;
  };
  if (q.errors.length > 0) {
    run.error = q.errors.join("; ");
    for (const e of q.errors) pushError(rec, `Could not fully restore: ${e}`);
  }
  rec.restores = [run, ...(rec.restores ?? [])];

  // Only a landed limit counts as restored. Warmup failing on its own leaves
  // the inbox sending, which is the half that matters for the record.
  if (q.sendingStopped) {
    const n = targets.length;
    rec.quarantinedEmails = (rec.quarantinedEmails ?? []).filter((e) => !want.has(lower(e)));
    rec.inboxesQuarantined = Math.max(0, rec.inboxesQuarantined - n);
    rec.inboxesActive = (rec.inboxesActive ?? 0) + n;
    rec.inboxesKept = (rec.inboxesKept ?? 0) + n;
    const held = quarantinedInboxes.get(id);
    if (held) quarantinedInboxes.set(id, held.filter((i) => !want.has(lower(i.email))));
    for (const i of r.inboxes) {
      if (want.has(lower(i.email))) {
        i.stoppedByUs = false;
        i.sendingNow = true;
      }
    }
    r.restorable = [];
    // A deletion that was waiting on inboxes now sending has nothing left to
    // take: it is closed rather than left offering to delete nothing.
    if (rec.status === "awaiting_confirmation" && (rec.quarantinedEmails ?? []).length === 0) {
      rec.status = "done";
      rec.phase = "finished";
      rec.phaseStates.deleting = "skipped";
    }
  }
  rec.updatedAt = Date.now();
  await persist(id);
  return { ok: q.sendingStopped, restored: q.sendingStopped ? targets.length : 0, error: run.error };
}

/**
 * Puts a written-off domain's Status back to what it was.
 *
 * The tenant row and any Google inbox rows cannot be taken off their tabs
 * safely — they are append-only lists other people work from — so those are
 * named for a person to remove. The record goes back to "kept" and is
 * watched again.
 */
export async function undoWriteOff(id: string): Promise<{ ok: boolean; error?: string }> {
  await loadOnce();
  const rec = records.get(id);
  if (!rec || !canRecheck(rec)) return { ok: false, error: "Job not found, or mid-run." };
  const s = rec.sheet;
  if (!s?.statusUpdated) return { ok: false, error: "The Domains row was not changed by this run, so there is nothing to undo." };
  const sheetId = envSpreadsheetId();
  if (!sheetId || !isSheetWritingConfigured()) return { ok: false, error: "The sheet is not configured for writing." };

  try {
    const grid = await readTab(sheetId, DEFAULT_SHEET_TAB);
    const header = grid[0] ?? [];
    const iStatus = headerIndex(header, COL_STATUS);
    const hit = findDomainRow(grid, rec.domain, {
      domain: headerIndex(header, COL_DOMAIN),
      status: iStatus,
      tenantEmail: headerIndex(header, COL_TENANT_EMAIL),
      tenantSource: headerIndex(header, COL_TENANT_SOURCE),
      client: headerIndex(header, "Client"),
      domainHost: headerIndex(header, COL_DOMAIN_HOST),
    });
    if (!hit.row || iStatus < 0) {
      return { ok: false, error: `${rec.domain} is no longer in the "${DEFAULT_SHEET_TAB}" tab, so its status could not be put back.` };
    }
    const to = s.previousStatus ?? "";
    await batchUpdateCells(sheetId, [
      { range: `${quoteTab(DEFAULT_SHEET_TAB)}!${columnLetter(iStatus)}${hit.row.rowNumber}`, value: to },
    ]);
    s.statusUpdated = false;
    s.revertedTo = to;
    s.revertedAt = Date.now();

    const cleanup: string[] = [];
    if (s.tenantQueued && s.tenantEmail) {
      cleanup.push(`remove ${s.tenantEmail} from "${CANCEL_TAB}"`);
    }
    if ((s.googleQueued?.length ?? 0) > 0) {
      cleanup.push(`remove ${s.googleQueued!.join(", ")} from "${GOOGLE_CANCEL_TAB}"`);
    }
    s.manualCleanup = cleanup.length > 0 ? `By hand: ${cleanup.join("; ")}.` : undefined;

    // Undoing the sheet is not a decision about the stopped inboxes. A
    // deletion that was waiting stays offered — someone can put the domain
    // back AND still clear out its dead inboxes, in either order. Only when
    // nothing was waiting does the record go straight to kept.
    const deletionPending =
      rec.status === "awaiting_confirmation" && (rec.quarantinedEmails ?? []).length > 0;
    if (!deletionPending) {
      rec.status = "kept";
      rec.phase = "finished";
      rec.phaseStates.deleting = "skipped";
      quarantinedInboxes.delete(id);
    }
    await scheduleRecheck(rec);
    rec.updatedAt = Date.now();
    await persist(id);
    return { ok: true };
  } catch (err) {
    pushError(rec, `Undo write-off failed: ${msg(err)}`);
    await persist(id);
    return { ok: false, error: msg(err) };
  }
}

/**
 * Deletes the inboxes this automation has stopped on a domain that is not
 * waiting on a deletion already — a kept domain whose weak inboxes were
 * stopped, or a written-off one whose deletion was declined or done before a
 * later check stopped a straggler.
 *
 * Only ever the quarantined list. The domain, its sheet row and its sending
 * inboxes are left alone: a kept domain stays kept.
 */
export async function deleteStoppedInboxes(
  id: string
): Promise<{ ok: boolean; deleted: number; error?: string }> {
  await loadOnce();
  const rec = records.get(id);
  if (!rec || !canRecheck(rec)) return { ok: false, deleted: 0, error: "Job not found, or mid-run." };
  if (rec.status === "awaiting_confirmation") {
    return { ok: false, deleted: 0, error: "This deletion is already waiting — use Delete on the card." };
  }
  if (rec.phaseStates.sheet === "pending" || rec.phaseStates.sheet === "waiting") {
    // runDelete would run the sheet step first, which is a write-off. A run
    // that never reached the sheet is re-run, not cleaned up piecemeal.
    return { ok: false, deleted: 0, error: "This run stopped before the sheet step. Allow a re-run instead." };
  }
  const stopped = rec.quarantinedEmails ?? [];
  if (stopped.length === 0) {
    return { ok: false, deleted: 0, error: "Nothing to delete — this automation has no stopped inboxes left on this domain." };
  }

  const wasKept = rec.status === "kept";
  const before = rec.inboxesDeleted;
  const errorsBefore = rec.errors.length;
  rec.confirmedAt = Date.now();
  await runDelete(id);
  // Losing its dead inboxes is not a write-off: a kept domain stays kept,
  // unless the deletion itself went wrong.
  if (wasKept && rec.errors.length === errorsBefore) {
    rec.status = "kept";
    rec.updatedAt = Date.now();
    await persist(id);
  }
  const deleted = rec.inboxesDeleted - before;
  return {
    ok: deleted > 0,
    deleted,
    error: deleted === 0 ? "None of the stopped inboxes could be deleted — see the card." : undefined,
  };
}

export async function rearmJob(id: string): Promise<boolean> {
  await loadOnce();
  const rec = records.get(id);
  if (!rec) return false;
  const inFlight =
    rec.status === "working" ||
    rec.status === "deleting" ||
    rec.status === "awaiting_confirmation";
  if (inFlight || rec.rearmedAt) return false;
  rec.rearmedAt = Date.now();
  // A re-armed record is history: a fresh run will schedule its own checks,
  // and two schedules on one domain would assess it twice over.
  if (rec.recheck) {
    rec.recheck.enabled = false;
    rec.recheck.nextAt = undefined;
    rec.recheck.endedReason = "The domain was re-armed, so this record stopped watching it.";
  }
  rec.updatedAt = rec.rearmedAt;
  await persist(id);
  return true;
}

/** Removes a record from the log entirely. */
export async function deleteJob(id: string): Promise<boolean> {
  await loadOnce();
  const rec = records.get(id);
  if (!rec) return false;
  records.delete(id);
  quarantinedInboxes.delete(id);
  try {
    await fs.unlink(fileFor(id));
  } catch {
    // already gone
  }
  return true;
}
