import "server-only";

import { createHash, randomUUID } from "crypto";
import { promises as fs, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { onShutdownFlush } from "@/lib/jobs/shutdown";
import { acquireSlot } from "@/lib/jobs/rate-limit";
import { listTags } from "@/lib/plusvibe-tags";
import { isSheetWritingConfigured, readTab } from "@/lib/google-sheets";
import { extractSheetId, fetchSheetGrid } from "@/lib/sheet";
import { prepareBatch, type TagSpec } from "@/lib/tags/bulk-tags";
import { chunk, verifyTags, ASSIGN_CHUNK, type InboxLite } from "@/lib/inbox-tags/plan";
import { ACCOUNTS_MAX_PAGES, ACCOUNTS_PAGE, assignTag, readInboxPage, resolveTag } from "@/lib/inbox-tags/api";
import { parseDomainHosts, planInboxes, topCounts } from "@/lib/tags/domain-tags";
import type { DomainTagsJob, DomainTagsStartPayload, WorkspaceOutcome } from "@/lib/jobs/domain-tags-types";
import { MAX_STORED_ERRORS } from "@/lib/jobs/domain-tags-types";

// Server-side manager for Auto-tag by Domain jobs.
//
// The sheet is read ONCE, up front; a sheet that can't be read stops the job
// before any workspace is touched, so nothing is half-tagged on a guess. Per
// workspace: find or create every tag in both sets, page through the inboxes
// counting them as they arrive, plan each inbox, assign per tag in chunks,
// then re-read a sample to confirm nothing lost a tag.
//
// ONE JOB AT A TIME per API key.

const JOBS_BASE = process.env.JOBS_DIR || path.join(process.cwd(), ".jobs-data");
const JOBS_DIR = path.join(JOBS_BASE, "domain-tags");
const VERIFY_SAMPLE = 100;

interface JobMeta {
  fingerprint: string;
  apiKey?: string;
  aborted: boolean;
}

const records = new Map<string, DomainTagsJob>();
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
    // best-effort
  }
}

const live = (r: DomainTagsJob) => r.status === "running";

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
        const parsed = JSON.parse(await fs.readFile(path.join(JOBS_DIR, f), "utf8")) as DomainTagsJob & { fingerprint?: string };
        const fingerprint = parsed.fingerprint ?? "";
        delete (parsed as { fingerprint?: string }).fingerprint;
        if (live(parsed)) parsed.status = "interrupted";
        parsed.workspaces = Array.isArray(parsed.workspaces) ? parsed.workspaces : [];
        parsed.tldTags = Array.isArray(parsed.tldTags) ? parsed.tldTags : [];
        parsed.platformTags = Array.isArray(parsed.platformTags) ? parsed.platformTags : [];
        parsed.errors = Array.isArray(parsed.errors) ? parsed.errors : [];
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
    super("An auto-tag job is already running — let it finish or stop it first.");
    this.name = "ActiveJobError";
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

const emptyCounts = () => ({ tldAssign: 0, tldHas: 0, tldNoTag: 0, platformAssign: 0, platformHas: 0, notInSheet: 0, hostNoTag: 0 });

export async function createJob(apiKey: string, payload: DomainTagsStartPayload): Promise<string> {
  await loadOnce();
  const fp = fingerprintKey(apiKey);
  const running = activeIdFor(fp);
  if (running) throw new ActiveJobError(running);

  const tld = prepareBatch(payload.tldTags);
  const platform = prepareBatch(payload.platformTags);
  for (const [set, b] of [["TLD", tld], ["platform", platform]] as const) {
    if (b.problems.size > 0) {
      const [i, p] = [...b.problems.entries()][0];
      throw new Error(`${set} tag ${i + 1}: ${p.join(" ")}`);
    }
  }
  if (tld.specs.length === 0) throw new Error("Add at least one TLD tag.");
  const sheetUrl = payload.sheetUrl?.trim() || undefined;
  if (sheetUrl && !extractSheetId(sheetUrl)) throw new Error("Couldn't read a Google Sheets link. Paste the full share URL.");

  const id = randomUUID();
  const now = Date.now();
  const n = payload.workspaces.length;
  const record: DomainTagsJob = {
    id,
    label: `${tld.specs.length} TLD tag${tld.specs.length === 1 ? "" : "s"}${platform.specs.length > 0 ? `, ${platform.specs.length} platform tag${platform.specs.length === 1 ? "" : "s"}` : ""} · ${n} workspace${n === 1 ? "" : "s"}`,
    status: "running",
    createdAt: now,
    updatedAt: now,
    tldTags: tld.specs,
    platformTags: platform.specs,
    sheetUrl,
    sheetTab: payload.sheetTab?.trim() || undefined,
    workspaces: payload.workspaces.map((w) => ({
      workspaceId: w.id,
      workspaceName: w.name,
      state: "pending" as const,
      inboxes: 0,
      tagsCreated: [],
      counts: emptyCounts(),
      assigned: 0,
      failed: 0,
    })),
    progress: { workspacesDone: 0, inboxesRead: 0, tldAssigned: 0, tldHad: 0, tldNoTag: 0, platformAssigned: 0, platformHad: 0, notInSheet: 0, hostNoTag: 0, failed: 0, tagsCreated: 0 },
    errors: [],
  };
  records.set(id, record);
  meta.set(id, { fingerprint: fp, apiKey, aborted: false });
  await persist(id);
  void runJob(id);
  return id;
}

// --- The run ---------------------------------------------------------------

class AbortedError extends Error {}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

function pushError(rec: DomainTagsJob, text: string) {
  if (rec.errors.length < MAX_STORED_ERRORS) rec.errors.push(text);
  else rec.errorsTruncated = true;
}

/**
 * The domain → host map. Through the service account when configured (works
 * for a private sheet), otherwise the public CSV export.
 */
async function readHosts(rec: DomainTagsJob): Promise<Map<string, string>> {
  if (!rec.sheetUrl) {
    rec.sheet = { domains: 0, withHost: 0, note: "No sheet given — TLD tags only." };
    return new Map();
  }
  const tab = rec.sheetTab || "📋 Domains";
  let grid: string[][];
  if (isSheetWritingConfigured()) {
    const sheetId = extractSheetId(rec.sheetUrl);
    if (!sheetId) throw new Error("Could not read the spreadsheet ID from the URL.");
    grid = await readTab(sheetId, tab);
  } else {
    grid = await fetchSheetGrid(rec.sheetUrl, tab);
  }
  const parsed = parseDomainHosts(grid);
  rec.sheet = { domains: parsed.rows, withHost: parsed.hosts.size };
  return parsed.hosts;
}

async function runJob(id: string) {
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m || !m.apiKey) return;
  const apiKey = m.apiKey;
  const check = () => {
    if (m.aborted) throw new AbortedError();
  };
  const touch = async () => {
    rec.updatedAt = Date.now();
    await persist(id);
  };

  try {
    let hosts: Map<string, string>;
    try {
      hosts = await readHosts(rec);
    } catch (err) {
      throw new Error(`Could not read the Domains sheet: ${msg(err)}`);
    }
    await touch();

    for (const ws of rec.workspaces) {
      check();
      try {
        await runWorkspace(rec, ws, apiKey, hosts, check, touch);
        ws.state = "done";
      } catch (err) {
        if (err instanceof AbortedError || m.aborted) throw err;
        ws.state = "error";
        ws.error = msg(err);
        pushError(rec, `${ws.workspaceName}: ${ws.error}`);
      }
      rec.progress.workspacesDone += 1;
      await touch();
    }
    const allFailed = rec.workspaces.length > 0 && rec.workspaces.every((w) => w.state === "error");
    rec.status = allFailed ? "error" : "done";
  } catch (err) {
    if (err instanceof AbortedError || m.aborted) rec.status = "aborted";
    else {
      pushError(rec, msg(err));
      rec.status = "error";
    }
  } finally {
    rec.finishedAt = Date.now();
    rec.updatedAt = rec.finishedAt;
    m.apiKey = undefined;
    await persist(id);
  }
}

async function ensureTags(
  rec: DomainTagsJob,
  ws: WorkspaceOutcome,
  apiKey: string,
  existing: { id: string; name: string }[],
  specs: TagSpec[]
): Promise<{ name: string; id: string }[]> {
  const out: { name: string; id: string }[] = [];
  for (const spec of specs) {
    const t = await resolveTag(apiKey, ws.workspaceId, existing, spec.name, spec.color);
    out.push({ name: spec.name, id: t.id });
    if (t.created) {
      existing.push({ id: t.id, name: spec.name });
      ws.tagsCreated.push(spec.name);
      rec.progress.tagsCreated += 1;
    }
  }
  return out;
}

async function runWorkspace(
  rec: DomainTagsJob,
  ws: WorkspaceOutcome,
  apiKey: string,
  hosts: Map<string, string>,
  check: () => void,
  touch: () => Promise<void>
) {
  // 1. Tags: every tag in both sets must exist here.
  ws.state = "tags";
  await touch();
  await acquireSlot();
  let existing;
  try {
    existing = await listTags(apiKey, ws.workspaceId);
  } catch (err) {
    throw new Error(`Could not read the workspace's tags: ${msg(err)}`);
  }
  let tldTags, platformTags;
  try {
    tldTags = await ensureTags(rec, ws, apiKey, existing, rec.tldTags);
    platformTags = await ensureTags(rec, ws, apiKey, existing, rec.platformTags);
  } catch (err) {
    throw new Error(`Could not find or create the tags: ${msg(err)}`);
  }
  await touch();

  // 2. Inboxes, counted as they arrive.
  ws.state = "fetching";
  const inboxes: InboxLite[] = [];
  for (let page = 0; page < ACCOUNTS_MAX_PAGES; page++) {
    check();
    let batch;
    try {
      batch = await readInboxPage(apiKey, ws.workspaceId, page * ACCOUNTS_PAGE, ACCOUNTS_PAGE);
    } catch (err) {
      throw new Error(`Could not read the inboxes: ${msg(err)}`);
    }
    inboxes.push(...batch);
    ws.inboxes = inboxes.length;
    rec.progress.inboxesRead += batch.length;
    await touch();
    if (batch.length < ACCOUNTS_PAGE) break;
  }

  // 3. Plan, then assign per tag in chunks.
  const plan = planInboxes(inboxes, tldTags, platformTags, hosts);
  ws.counts = plan.counts;
  if (plan.unknownTlds.size > 0) ws.unknownTlds = topCounts(plan.unknownTlds);
  if (plan.unknownHosts.size > 0) ws.unknownHosts = topCounts(plan.unknownHosts);
  const p = rec.progress;
  p.tldHad += plan.counts.tldHas;
  p.tldNoTag += plan.counts.tldNoTag;
  p.platformHad += plan.counts.platformHas;
  p.notInSheet += plan.counts.notInSheet;
  p.hostNoTag += plan.counts.hostNoTag;
  ws.state = "tagging";
  await touch();

  const tldIds = new Set(tldTags.map((t) => t.id));
  const nameOf = new Map([...tldTags, ...platformTags].map((t) => [t.id, t.name]));
  const expected = new Map<string, string[]>();
  for (const [tagId, ids] of plan.assignments) {
    for (const part of chunk(ids, ASSIGN_CHUNK)) {
      check();
      try {
        await assignTag(apiKey, ws.workspaceId, part, tagId);
        ws.assigned += part.length;
        if (tldIds.has(tagId)) p.tldAssigned += part.length;
        else p.platformAssigned += part.length;
        for (const i of part) expected.set(i, [...(expected.get(i) ?? []), tagId]);
      } catch (err) {
        ws.failed += part.length;
        p.failed += part.length;
        pushError(rec, `${ws.workspaceName}: assigning "${nameOf.get(tagId) ?? tagId}" to ${part.length} inbox${part.length === 1 ? "" : "es"} failed: ${msg(err)}`);
      }
      await touch();
    }
  }

  // 4. Verify on a sample.
  if (expected.size > 0) {
    ws.state = "verifying";
    await touch();
    try {
      const after = await readInboxPage(apiKey, ws.workspaceId, 0, Math.min(VERIFY_SAMPLE, ACCOUNTS_PAGE));
      const v = verifyTags(inboxes, after, expected);
      ws.verified = { checked: v.checked, lostTags: v.lostTags.length, missingTag: v.missingTag.length };
      if (v.lostTags.length > 0) {
        pushError(rec, `${ws.workspaceName}: ${v.lostTags.length} inbox${v.lostTags.length === 1 ? "" : "es"} read back with a tag missing that it had before (${v.lostTags.slice(0, 3).join(", ")}${v.lostTags.length > 3 ? ", …" : ""}).`);
      }
      if (v.missingTag.length > 0) {
        pushError(rec, `${ws.workspaceName}: ${v.missingTag.length} inbox${v.missingTag.length === 1 ? "" : "es"} read back without the tag just assigned (${v.missingTag.slice(0, 3).join(", ")}${v.missingTag.length > 3 ? ", …" : ""}).`);
      }
    } catch (err) {
      pushError(rec, `${ws.workspaceName}: tagged, but the check afterwards could not read the inboxes: ${msg(err)}`);
    }
  }
}

// --- Query / control -------------------------------------------------------

function owned(apiKey: string, id: string) {
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m || m.fingerprint !== fingerprintKey(apiKey)) return null;
  return { rec, m };
}

export async function listJobs(apiKey: string): Promise<DomainTagsJob[]> {
  await loadOnce();
  const fp = fingerprintKey(apiKey);
  const out: DomainTagsJob[] = [];
  for (const [id, m] of meta) {
    if (m.fingerprint !== fp) continue;
    const rec = records.get(id);
    if (rec) out.push(rec);
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

/** Stops a running job. Tags already assigned stay assigned. */
export async function abortJob(apiKey: string, id: string): Promise<boolean> {
  await loadOnce();
  const o = owned(apiKey, id);
  if (!o) return false;
  o.m.aborted = true;
  return true;
}

export async function deleteJob(apiKey: string, id: string): Promise<boolean> {
  await loadOnce();
  const o = owned(apiKey, id);
  if (!o) return false;
  o.m.aborted = true;
  records.delete(id);
  meta.delete(id);
  try {
    await fs.unlink(fileFor(id));
  } catch {
    // already gone
  }
  return true;
}
