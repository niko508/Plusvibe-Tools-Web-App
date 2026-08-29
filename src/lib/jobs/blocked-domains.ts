import "server-only";

import { randomUUID } from "crypto";
import { promises as fs, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { onShutdownFlush } from "@/lib/jobs/shutdown";
import {
  appendRow,
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
import {
  BLOCKED_STATUS,
  CANCEL_TAB,
  COL_CANCEL_TENANT,
  buildCancelRow,
  findDomainRow,
  headerIndex,
  matchWorkspaceByClient,
  tenantAlreadyQueued,
} from "@/lib/blocked-domains/sheet-plan";
import { loadSettings } from "@/lib/blocked-domains/settings";
import {
  deleteInbox,
  listInboxes,
  listWorkspaces,
  quarantineInboxes,
  type Inbox,
} from "@/lib/blocked-domains/api";
import type {
  BlockedDomainJob,
  PhaseState,
  SheetOutcome,
} from "@/lib/jobs/blocked-domains-types";
import { MAX_STORED_ERRORS } from "@/lib/jobs/blocked-domains-types";

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

/** How long a finished domain still swallows repeat webhook hits. */
const DEDUPE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const records = new Map<string, BlockedDomainJob>();
/** Memory-only: the inboxes found, so confirming doesn't re-scan. */
const foundInboxes = new Map<string, Inbox[]>();
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
  const existing = [...records.values()]
    .filter((r) => r.domain === domain)
    .sort((a, b) => b.createdAt - a.createdAt)[0];

  if (existing) {
    const unfinished =
      existing.status === "working" ||
      existing.status === "deleting" ||
      existing.status === "awaiting_confirmation";
    const recent = now - existing.createdAt < DEDUPE_WINDOW_MS;
    if (unfinished || recent) {
      existing.duplicateHits += 1;
      existing.lastDuplicateAt = now;
      existing.updatedAt = now;
      await persist(existing.id);
      return { outcome: "duplicate", job: existing };
    }
  }

  const rec: BlockedDomainJob = {
    id: randomUUID(),
    domain,
    status: "working",
    phase: "locating",
    phaseStates: {
      locating: "running",
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
    const { workspaceId, workspaceName, inboxes, viaSheet, scanned, client } =
      await locate(apiKey, rec);

    rec.workspaceId = workspaceId ?? undefined;
    rec.workspaceName = workspaceName ?? undefined;
    rec.foundViaSheet = viaSheet;
    rec.workspacesScanned = scanned;
    rec.inboxesFound = inboxes.length;
    if (client) rec.sheet = { ...(rec.sheet ?? emptySheet()), client };
    foundInboxes.set(id, inboxes);
    rec.phaseStates.locating = "done";
    rec.updatedAt = Date.now();
    await persist(id);

    if (inboxes.length === 0) {
      // Nothing to stop or delete, but the sheet still needs updating — the
      // domain is blocked whether or not Plusvibe still holds inboxes for it.
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

    // --- Phase 2: quarantine ---------------------------------------------
    rec.phase = "quarantining";
    rec.phaseStates.quarantining = "running";
    await persist(id);
    try {
      await quarantineInboxes(
        apiKey,
        workspaceId!,
        inboxes.map((i) => i.id)
      );
      rec.inboxesQuarantined = inboxes.length;
      rec.phaseStates.quarantining = "done";
    } catch (err) {
      rec.phaseStates.quarantining = "error";
      pushError(rec, `Could not stop sending/warmup: ${msg(err)}`);
    }
    rec.updatedAt = Date.now();
    await persist(id);

    // --- Hand off to deletion, or wait ------------------------------------
    const { autoDelete } = await loadSettings();
    if (autoDelete) {
      rec.autoDeleted = true;
      rec.confirmedAt = Date.now();
      await persist(id);
      await runDeleteAndSheet(id);
    } else {
      rec.status = "awaiting_confirmation";
      rec.phase = "deleting";
      rec.phaseStates.deleting = "waiting";
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
      });
      if (hit.row) {
        client = hit.row.client || undefined;
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
  };
}

/** Phases 3 and 4: delete the inboxes, then update the sheet. */
async function runDeleteAndSheet(id: string) {
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
  rec.phase = "deleting";
  rec.phaseStates.deleting = "running";
  rec.updatedAt = Date.now();
  await persist(id);

  // The inbox list is memory-only, so a restart between quarantine and confirm
  // means re-finding them rather than deleting nothing.
  let inboxes = foundInboxes.get(id);
  if (!inboxes) {
    try {
      inboxes = (await listInboxes(apiKey, rec.workspaceId)).filter((i) =>
        inboxIsOnDomain(i.email, rec.domain)
      );
      rec.inboxesFound = inboxes.length;
    } catch (err) {
      rec.phaseStates.deleting = "error";
      pushError(rec, `Could not re-read the inboxes: ${msg(err)}`);
      inboxes = [];
    }
  }

  for (const inbox of inboxes) {
    try {
      await deleteInbox(apiKey, rec.workspaceId, inbox.email);
      rec.inboxesDeleted += 1;
    } catch (err) {
      pushError(rec, `${inbox.email}: ${msg(err)}`);
    }
    if (rec.inboxesDeleted % 10 === 0) {
      rec.updatedAt = Date.now();
      await persist(id);
    }
  }
  foundInboxes.delete(id);
  rec.phaseStates.deleting =
    rec.inboxesDeleted === inboxes.length ? "done" : "error";
  rec.updatedAt = Date.now();
  await persist(id);

  await runSheet(rec);
  finish(rec);
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
  void runDeleteAndSheet(id);
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
  rec.phaseStates.deleting = "skipped";
  rec.phaseStates.sheet = "skipped";
  rec.updatedAt = Date.now();
  foundInboxes.delete(id);
  await persist(id);
  return true;
}

/** Removes a finished record from the log. */
export async function deleteJob(id: string): Promise<boolean> {
  await loadOnce();
  const rec = records.get(id);
  if (!rec) return false;
  records.delete(id);
  foundInboxes.delete(id);
  try {
    await fs.unlink(fileFor(id));
  } catch {
    // already gone
  }
  return true;
}
