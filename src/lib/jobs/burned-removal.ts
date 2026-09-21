import "server-only";

import { createHash, randomUUID } from "crypto";
import { promises as fs, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { onShutdownFlush } from "@/lib/jobs/shutdown";
import {
  appendRows,
  batchUpdateCells,
  columnLetter,
  envSpreadsheetId,
  isSheetWritingConfigured,
  quoteTab,
  readTab,
} from "@/lib/google-sheets";
import { extractSheetId } from "@/lib/sheet";
import {
  DEFAULT_SHEET_TAB,
  COL_DOMAIN,
  COL_STATUS,
  COL_TENANT_EMAIL,
  COL_TENANT_SOURCE,
} from "@/lib/jobs/azure-warmup-types";
import {
  CANCEL_TAB,
  GOOGLE_CANCEL_TAB,
  GOOGLE_QUEUE,
  TENANT_QUEUE,
  planQueueTabWrites,
  type GoogleTabPlan,
  type QueueTab,
} from "@/lib/blocked-domains/sheet-plan";
import { deleteInbox, listInboxes, type Inbox } from "@/lib/blocked-domains/api";
import { ESP_LABELS, NOUNS, levelOf } from "@/lib/burned/settings";
import {
  describeRun,
  domainsOf,
  inboxesFor,
  planDomainsTab,
  targetsFrom,
  tenantsToQueue,
  REMOVED_STATUS,
  type DomainLookup,
  type RemovalTarget,
  type TargetResult,
} from "@/lib/burned/removal";
import { getJob as getScan } from "@/lib/jobs/burned";
import type {
  BurnedRemovalJob,
  RemovalStartPayload,
  SheetOutcome,
} from "@/lib/jobs/burned-removal-types";
import { MAX_STORED_ERRORS } from "@/lib/jobs/burned-removal-types";

// Server-side manager for "Remove Inboxes & Domains".
//
// Takes a finished scan's burned rows and, in this order:
//   1. records them in the Email Infrastructure sheet
//   2. deletes their inboxes in Plusvibe
//
// The sheet comes first on purpose: it is the record of what still has to be
// cancelled, and a mailbox deleted before its tenant is queued is a
// subscription nobody will remember to stop. A row the sheet could not
// record is therefore left alone in Plusvibe rather than deleted anyway —
// re-running after fixing the sheet picks it up, because everything here is
// safe to repeat.
//
// Runs in the Node process so closing the tab doesn't stop it, and persists
// to disk so the progress can be read back. The API key is memory-only.
//
// ONE REMOVAL AT A TIME per API key: two would compete for the same 5 req/s
// budget, and worse, two Sheets writers filling the same blank rows would
// overwrite each other.

const JOBS_BASE = process.env.JOBS_DIR || path.join(process.cwd(), ".jobs-data");
const JOBS_DIR = path.join(JOBS_BASE, "burned-removal");

interface JobMeta {
  fingerprint: string;
  apiKey?: string;
  aborted: boolean;
}

const records = new Map<string, BurnedRemovalJob>();
const meta = new Map<string, JobMeta>();
let loaded = false;

// --- Persistence -----------------------------------------------------------

function fingerprintKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

function fileFor(id: string) {
  return path.join(JOBS_DIR, `${id}.json`);
}

async function persist(id: string) {
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m) return;
  try {
    await fs.mkdir(JOBS_DIR, { recursive: true });
    await fs.writeFile(fileFor(id), JSON.stringify({ ...rec, fingerprint: m.fingerprint }), "utf8");
  } catch {
    // best-effort; a failed write must not kill the run
  }
}

const live = (r: BurnedRemovalJob) => r.status === "running";

function flushRunningSync() {
  if (![...records.values()].some(live)) return;
  try {
    mkdirSync(JOBS_DIR, { recursive: true });
  } catch {
    return;
  }
  for (const [id, rec] of records) {
    if (!live(rec)) continue;
    const m = meta.get(id);
    if (!m) continue;
    rec.status = "interrupted";
    rec.updatedAt = Date.now();
    try {
      writeFileSync(fileFor(id), JSON.stringify({ ...rec, fingerprint: m.fingerprint }), "utf8");
    } catch {
      // best-effort
    }
  }
}

onShutdownFlush(flushRunningSync);

async function loadOnce() {
  if (loaded) return;
  loaded = true;
  try {
    await fs.mkdir(JOBS_DIR, { recursive: true });
    for (const f of await fs.readdir(JOBS_DIR)) {
      if (!f.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(JOBS_DIR, f), "utf8")) as BurnedRemovalJob & {
          fingerprint?: string;
        };
        const fingerprint = parsed.fingerprint ?? "";
        delete (parsed as { fingerprint?: string }).fingerprint;
        if (live(parsed)) parsed.status = "interrupted";
        parsed.rows = Array.isArray(parsed.rows) ? parsed.rows : [];
        parsed.workspaces = Array.isArray(parsed.workspaces) ? parsed.workspaces : [];
        parsed.errors = Array.isArray(parsed.errors) ? parsed.errors : [];
        parsed.sheet = { ...emptySheet(), ...(parsed.sheet ?? {}) };
        records.set(parsed.id, parsed);
        meta.set(parsed.id, { fingerprint, aborted: false });
      } catch {
        // skip corrupt record
      }
    }
  } catch {
    // nothing to load
  }
}

// --- Creation --------------------------------------------------------------

export class ActiveJobError extends Error {
  constructor(readonly activeJobId: string) {
    super("A removal is already running — let it finish or stop it first.");
    this.name = "ActiveJobError";
  }
}

/** Anything the caller got wrong: no scan, no burned rows, no sheet. */
export class RemovalProblem extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "RemovalProblem";
  }
}

function activeIdFor(fp: string): string | null {
  for (const [id, m] of meta) {
    if (m.fingerprint !== fp) continue;
    const r = records.get(id);
    if (r && live(r)) return id;
  }
  return null;
}

function emptySheet(): SheetOutcome {
  return {
    statusUpdated: 0,
    statusAlready: 0,
    tenantsQueued: 0,
    tenantsAlready: 0,
    inboxesQueued: 0,
    inboxesAlready: 0,
  };
}

export async function createJob(apiKey: string, payload: RemovalStartPayload): Promise<string> {
  await loadOnce();
  const fp = fingerprintKey(apiKey);
  const running = activeIdFor(fp);
  if (running) throw new ActiveJobError(running);

  const scan = await getScan(apiKey, payload.scanJobId);
  if (!scan) throw new RemovalProblem("That scan is no longer here — run one and try again.", 404);
  if (scan.status === "running") {
    throw new RemovalProblem("That scan is still running — let it finish first.", 409);
  }

  const targets = targetsFrom(scan.rows ?? []);
  if (targets.length === 0) {
    throw new RemovalProblem("That scan found nothing burned, so there is nothing to remove.");
  }

  // Both halves of the sheet step are checked before anything is deleted: a
  // run that can't write the sheet would delete inboxes and record none of
  // them, which is the one outcome there's no way back from.
  if (!isSheetWritingConfigured()) {
    throw new RemovalProblem(
      "Google Sheets writing isn't set up, so nothing was touched — set GOOGLE_SERVICE_ACCOUNT_JSON and share the sheet with the service account as an Editor.",
      501
    );
  }
  const spreadsheetId = (payload.sheetUrl ? extractSheetId(payload.sheetUrl) : null) ?? envSpreadsheetId();
  if (!spreadsheetId) {
    throw new RemovalProblem(
      "No Email Infrastructure sheet to write to — paste its link, or set SPREADSHEET_ID.",
      400
    );
  }

  const id = randomUUID();
  const now = Date.now();
  const noun = NOUNS[levelOf(scan.esp)];
  const record: BurnedRemovalJob = {
    id,
    label: `${ESP_LABELS[scan.esp]} · ${targets.length.toLocaleString()} burned ${
      targets.length === 1 ? noun.one : noun.many
    }`,
    status: "running",
    createdAt: now,
    updatedAt: now,
    scanJobId: scan.id,
    esp: scan.esp,
    spreadsheetId,
    phase: "sheet",
    phaseStates: { sheet: "pending", plusvibe: "pending" },
    sheet: emptySheet(),
    rows: targets.map((t) => ({
      workspaceId: t.workspaceId,
      workspaceName: t.workspaceName,
      name: t.name,
      domain: t.domain,
      state: "pending" as const,
      inboxesFound: 0,
      inboxesDeleted: 0,
    })),
    workspaces: workspacesOf(targets),
    progress: { recorded: 0, removed: 0, total: targets.length, inboxesDeleted: 0 },
    errors: [],
  };
  records.set(id, record);
  meta.set(id, { fingerprint: fp, apiKey, aborted: false });
  await persist(id);
  void runJob(id, targets);
  return id;
}

function workspacesOf(targets: RemovalTarget[]) {
  const byId = new Map<string, { workspaceId: string; workspaceName: string; targets: number }>();
  for (const t of targets) {
    const found = byId.get(t.workspaceId);
    if (found) found.targets += 1;
    else byId.set(t.workspaceId, { workspaceId: t.workspaceId, workspaceName: t.workspaceName, targets: 1 });
  }
  return [...byId.values()].map((w) => ({
    ...w,
    state: "pending" as const,
    inboxesDeleted: 0,
  }));
}

// --- The run ---------------------------------------------------------------

class AbortedError extends Error {}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

function pushError(rec: BurnedRemovalJob, text: string) {
  if (rec.errors.length < MAX_STORED_ERRORS) rec.errors.push(text);
  else rec.errorsTruncated = true;
}

/** Applies a cancel-tab plan: the in-place cells first, then any overflow. */
async function writeQueuePlan(
  spreadsheetId: string,
  plan: GoogleTabPlan,
  queue: QueueTab
): Promise<void> {
  if (plan.updates.length > 0) {
    await batchUpdateCells(
      spreadsheetId,
      plan.updates.map((u) => ({
        range: `${quoteTab(queue.tab)}!${columnLetter(u.column)}${u.row}`,
        value: u.value,
      }))
    );
  }
  if (plan.append.length > 0) await appendRows(spreadsheetId, queue.tab, plan.append);
}

/**
 * Phase one: everything the sheet has to say, in as few calls as it takes.
 *
 * Microsoft reads 📋 Domains once for every burned domain, sets all the
 * Status cells in one batch, then queues every tenant in one more. Google
 * only touches 🛑 Google Inboxes to Cancel, with the source column left blank.
 */
async function runSheet(rec: BurnedRemovalJob, targets: RemovalTarget[], check: () => void) {
  rec.phase = "sheet";
  rec.phaseStates.sheet = "running";
  const byName = new Map(rec.rows.map((r) => [`${r.workspaceId}|${r.name}`, r]));
  const rowFor = (t: RemovalTarget) => byName.get(`${t.workspaceId}|${t.name}`)!;

  if (rec.esp === "google") {
    check();
    const grid = await readTab(rec.spreadsheetId, GOOGLE_CANCEL_TAB);
    // The source dropdown is deliberately left empty: a Google mailbox has no
    // tenant behind it, and guessing a source would be worse than blank.
    const plan = planQueueTabWrites(
      grid,
      targets.map((t) => ({ key: t.name, source: "" })),
      GOOGLE_QUEUE
    );
    if (plan.problem) {
      rec.sheet.error = plan.problem;
      rec.phaseStates.sheet = "error";
      pushError(rec, plan.problem);
      for (const t of targets) markSkipped(rec, rowFor(t), plan.problem);
      return;
    }
    check();
    await writeQueuePlan(rec.spreadsheetId, plan, GOOGLE_QUEUE);

    const queued = new Set([...plan.queued, ...plan.moved]);
    const already = new Set(plan.already);
    rec.sheet.inboxesQueued = queued.size;
    rec.sheet.inboxesAlready = already.size;
    for (const t of targets) {
      const row = rowFor(t);
      if (already.has(t.name)) row.listedAlready = true;
      row.state = "queued";
      rec.progress.recorded += 1;
    }
    rec.phaseStates.sheet = "done";
    return;
  }

  // --- Microsoft -----------------------------------------------------------
  check();
  const grid = await readTab(rec.spreadsheetId, DEFAULT_SHEET_TAB);
  const plan = planDomainsTab(
    grid,
    domainsOf(targets),
    {
      domain: COL_DOMAIN,
      status: COL_STATUS,
      tenantEmail: COL_TENANT_EMAIL,
      tenantSource: COL_TENANT_SOURCE,
    },
    DEFAULT_SHEET_TAB
  );
  if (plan.problem) {
    rec.sheet.error = plan.problem;
    rec.phaseStates.sheet = "error";
    pushError(rec, plan.problem);
    for (const t of targets) markSkipped(rec, rowFor(t), plan.problem);
    return;
  }

  const lookupOf = new Map<string, DomainLookup>(plan.lookups.map((l) => [l.domain, l]));
  for (const l of plan.lookups) {
    if (l.problem) pushError(rec, l.problem);
    if (l.matches > 1) {
      pushError(
        rec,
        `${l.domain} appears ${l.matches} times in "${DEFAULT_SHEET_TAB}" — only row ${l.rowNumber} was updated.`
      );
    }
  }

  // The status cells, all at once.
  if (plan.updates.length > 0) {
    check();
    await batchUpdateCells(
      rec.spreadsheetId,
      plan.updates.map((u) => ({
        range: `${quoteTab(DEFAULT_SHEET_TAB)}!${columnLetter(u.column)}${u.row}`,
        value: u.value,
      }))
    );
    rec.sheet.statusUpdated = plan.updates.length;
  }
  rec.sheet.statusAlready = plan.lookups.filter((l) => l.statusAlready).length;

  // The tenants. Deliberately independent of the status above: a domain that
  // was already "Not Active" still has a tenant to cancel, and one marked by
  // hand is exactly where the tenant is most likely to have been forgotten.
  const { entries, missing } = tenantsToQueue(plan.lookups);
  for (const domain of missing) {
    pushError(
      rec,
      `${domain} has no ${COL_TENANT_EMAIL} in the sheet, so nothing was added to "${CANCEL_TAB}" — its inboxes were left alone.`
    );
  }
  let queued = new Set<string>();
  let already = new Set<string>();
  if (entries.length > 0) {
    check();
    const cancelGrid = await readTab(rec.spreadsheetId, CANCEL_TAB);
    const tenantPlan = planQueueTabWrites(cancelGrid, entries, TENANT_QUEUE);
    if (tenantPlan.problem) {
      rec.sheet.error = tenantPlan.problem;
      rec.phaseStates.sheet = "error";
      pushError(rec, tenantPlan.problem);
      for (const t of targets) markSkipped(rec, rowFor(t), tenantPlan.problem);
      return;
    }
    check();
    await writeQueuePlan(rec.spreadsheetId, tenantPlan, TENANT_QUEUE);
    queued = new Set([...tenantPlan.queued, ...tenantPlan.moved]);
    already = new Set(tenantPlan.already);
    rec.sheet.tenantsQueued = queued.size;
    rec.sheet.tenantsAlready = already.size;
  }

  for (const t of targets) {
    const row = rowFor(t);
    const lookup = lookupOf.get(t.domain || t.name);
    if (!lookup || !lookup.rowNumber) {
      markSkipped(rec, row, lookup?.problem ?? `${t.name} isn't in the "${DEFAULT_SHEET_TAB}" tab.`);
      continue;
    }
    if (!lookup.tenantEmail) {
      markSkipped(
        rec,
        row,
        `No ${COL_TENANT_EMAIL} in the sheet, so the tenant was never queued to cancel and the inboxes were left alone. The row is marked ${REMOVED_STATUS}.`
      );
      continue;
    }
    row.tenant = lookup.tenantEmail;
    if (lookup.statusAlready) row.statusAlready = true;
    if (already.has(lookup.tenantEmail.toLowerCase())) row.tenantAlready = true;
    row.state = "queued";
    rec.progress.recorded += 1;
  }
  rec.phaseStates.sheet = rec.rows.some((r) => r.state === "skipped") ? "error" : "done";
}

/**
 * A row the sheet could not record, and so will not be deleted.
 *
 * Counted as handled for the progress bar, because the run is finished with
 * it — it just finished by leaving it alone.
 */
function markSkipped(rec: BurnedRemovalJob, row: TargetResult, note: string) {
  row.state = "skipped";
  row.note = note;
  rec.progress.removed += 1;
}

/** Phase two: the inboxes, one workspace at a time. */
async function runPlusvibe(
  apiKey: string,
  rec: BurnedRemovalJob,
  targets: RemovalTarget[],
  check: () => void
) {
  rec.phase = "plusvibe";
  rec.phaseStates.plusvibe = "running";
  const byName = new Map(rec.rows.map((r) => [`${r.workspaceId}|${r.name}`, r]));

  for (const ws of rec.workspaces) {
    check();
    const mine = targets.filter(
      (t) => t.workspaceId === ws.workspaceId && byName.get(`${t.workspaceId}|${t.name}`)?.state === "queued"
    );
    if (mine.length === 0) {
      ws.state = "done";
      continue;
    }

    // One listing for the whole workspace, however many targets it holds.
    ws.state = "listing";
    let inboxes: Inbox[];
    try {
      inboxes = await listInboxes(apiKey, ws.workspaceId);
    } catch (err) {
      ws.state = "error";
      ws.error = `Could not list the inboxes: ${msg(err)}`;
      pushError(rec, `${ws.workspaceName}: ${ws.error}`);
      for (const t of mine) {
        const row = byName.get(`${t.workspaceId}|${t.name}`)!;
        row.state = "error";
        row.note = ws.error;
        rec.progress.removed += 1;
      }
      continue;
    }

    ws.state = "deleting";
    for (const t of mine) {
      check();
      const row = byName.get(`${t.workspaceId}|${t.name}`)!;
      row.state = "deleting";
      const mailboxes = inboxesFor(t, inboxes, rec.esp);
      row.inboxesFound = mailboxes.length;
      if (mailboxes.length === 0) {
        // Already gone — a re-run, or someone deleted them by hand. The sheet
        // is still recorded, which is the half that matters.
        row.state = "done";
        row.note = "No inboxes left in Plusvibe — already gone.";
        rec.progress.removed += 1;
        continue;
      }
      let failed = 0;
      for (const inbox of mailboxes) {
        check();
        try {
          await deleteInbox(apiKey, ws.workspaceId, inbox.email);
          row.inboxesDeleted += 1;
          ws.inboxesDeleted += 1;
          rec.progress.inboxesDeleted += 1;
        } catch (err) {
          failed += 1;
          pushError(rec, `${inbox.email}: could not delete it (${msg(err)}).`);
        }
      }
      row.state = failed > 0 ? "error" : "done";
      if (failed > 0) {
        row.note = `${failed} of ${mailboxes.length} could not be deleted.`;
      }
      rec.progress.removed += 1;
      rec.updatedAt = Date.now();
    }
    ws.state = "done";
  }

  rec.phaseStates.plusvibe = rec.rows.some((r) => r.state === "error") ? "error" : "done";
}

async function runJob(id: string, targets: RemovalTarget[]) {
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m || !m.apiKey) return;
  const apiKey = m.apiKey;
  const check = () => {
    if (m.aborted) throw new AbortedError();
  };

  try {
    try {
      await runSheet(rec, targets, check);
    } catch (err) {
      if (err instanceof AbortedError) throw err;
      // A sheet failure stops the run rather than deleting anything: without
      // the record there is nothing to say which tenants are still being paid
      // for, and the inboxes can always be deleted on a later attempt.
      rec.sheet.error = msg(err);
      rec.phaseStates.sheet = "error";
      pushError(rec, `The sheet could not be updated: ${msg(err)}. Nothing was deleted in Plusvibe.`);
      for (const row of rec.rows) {
        if (row.state === "pending") markSkipped(rec, row, "The sheet step failed, so this was left alone.");
      }
      rec.status = "error";
      return;
    }
    rec.updatedAt = Date.now();
    await persist(id);

    await runPlusvibe(apiKey, rec, targets, check);

    const problems = rec.rows.some((r) => r.state === "error" || r.state === "skipped");
    rec.status = problems ? "error" : "done";
  } catch (err) {
    if (err instanceof AbortedError || m.aborted) {
      rec.status = "aborted";
    } else {
      pushError(rec, msg(err));
      rec.status = "error";
    }
  } finally {
    rec.phase = "finished";
    if (rec.phaseStates.plusvibe === "running") rec.phaseStates.plusvibe = "error";
    if (rec.phaseStates.sheet === "pending") rec.phaseStates.sheet = "skipped";
    rec.label = `${rec.label} · ${describeRun(rec.rows, rec.esp)}`;
    rec.finishedAt = Date.now();
    rec.updatedAt = rec.finishedAt;
    m.apiKey = undefined;
    await persist(id);
  }
}

// --- Query / control -------------------------------------------------------

export async function listJobs(apiKey: string): Promise<BurnedRemovalJob[]> {
  await loadOnce();
  const fp = fingerprintKey(apiKey);
  const out: BurnedRemovalJob[] = [];
  for (const [id, m] of meta) {
    if (m.fingerprint !== fp) continue;
    const rec = records.get(id);
    if (rec) out.push(rec);
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

export async function abortJob(apiKey: string, id: string): Promise<boolean> {
  await loadOnce();
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m || m.fingerprint !== fingerprintKey(apiKey)) return false;
  m.aborted = true;
  return true;
}

export async function deleteJob(apiKey: string, id: string): Promise<boolean> {
  await loadOnce();
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m || m.fingerprint !== fingerprintKey(apiKey)) return false;
  m.aborted = true;
  records.delete(id);
  meta.delete(id);
  try {
    await fs.unlink(fileFor(id));
  } catch {
    // already gone
  }
  return true;
}
