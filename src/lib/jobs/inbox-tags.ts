import "server-only";

import { createHash, randomUUID } from "crypto";
import { promises as fs, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { onShutdownFlush } from "@/lib/jobs/shutdown";
import { acquireSlot } from "@/lib/jobs/rate-limit";
import { plusvibeGet, plusvibePost, plusvibePut } from "@/lib/plusvibe-server";
import { listTags } from "@/lib/plusvibe-tags";
import { classifyApiError, findExisting } from "@/lib/tags/bulk-tags";
import {
  ASSIGN_CHUNK,
  chunk,
  countProviders,
  describeRules,
  planRule,
  prepareRules,
  verifyTags,
  type InboxLite,
} from "@/lib/inbox-tags/plan";
import type {
  InboxTagsJob,
  InboxTagsStartPayload,
  RuleOutcome,
  WorkspaceOutcome,
} from "@/lib/jobs/inbox-tags-types";
import { MAX_STORED_ERRORS } from "@/lib/jobs/inbox-tags-types";

// Server-side manager for Update Inbox Tags jobs.
//
// Runs in the background and reports as it goes: per workspace the inboxes
// are counted page by page while they load, and each assign call updates the
// totals. Existing tags on an inbox are never touched — the assign call is
// additive and an inbox that already has the tag is left out of it.
//
// ONE JOB AT A TIME per API key. Two jobs on the same workspace would race to
// create the same tag and read stale tag lists; queuing them is simpler.

const JOBS_BASE = process.env.JOBS_DIR || path.join(process.cwd(), ".jobs-data");
const JOBS_DIR = path.join(JOBS_BASE, "inbox-tags");
const ACCOUNTS_PAGE = 100;
const ACCOUNTS_MAX_PAGES = 200; // 20k inboxes
/** Inboxes re-read after assigning, to confirm nothing lost a tag. */
const VERIFY_SAMPLE = 100;

interface JobMeta {
  fingerprint: string;
  apiKey?: string;
  aborted: boolean;
}

const records = new Map<string, InboxTagsJob>();
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

const live = (r: InboxTagsJob) => r.status === "running";

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
        const parsed = JSON.parse(await fs.readFile(path.join(JOBS_DIR, f), "utf8")) as InboxTagsJob & { fingerprint?: string };
        const fingerprint = parsed.fingerprint ?? "";
        delete (parsed as { fingerprint?: string }).fingerprint;
        // The key lived only in memory, so a job caught mid-run can't go on.
        if (live(parsed)) parsed.status = "interrupted";
        parsed.workspaces = Array.isArray(parsed.workspaces) ? parsed.workspaces : [];
        parsed.rules = Array.isArray(parsed.rules) ? parsed.rules : [];
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
    super("An inbox tagging job is already running — let it finish or stop it first.");
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

export async function createJob(apiKey: string, payload: InboxTagsStartPayload): Promise<string> {
  await loadOnce();
  const fp = fingerprintKey(apiKey);
  const running = activeIdFor(fp);
  if (running) throw new ActiveJobError(running);

  const prepared = prepareRules(payload.rules);
  if (prepared.problems.size > 0) {
    const [i, p] = [...prepared.problems.entries()][0];
    throw new Error(`Rule ${i + 1}: ${p.join(" ")}`);
  }
  if (prepared.rules.length === 0) throw new Error("Add at least one rule.");

  const id = randomUUID();
  const now = Date.now();
  const n = payload.workspaces.length;
  const record: InboxTagsJob = {
    id,
    label: `${describeRules(prepared.rules)} · ${n} workspace${n === 1 ? "" : "s"}`,
    status: "running",
    createdAt: now,
    updatedAt: now,
    rules: prepared.rules,
    workspaces: payload.workspaces.map((w) => ({
      workspaceId: w.id,
      workspaceName: w.name,
      state: "pending" as const,
      inboxes: 0,
      providers: { google: 0, microsoft: 0, other: 0 },
      rules: prepared.rules.map((_, i) => ({ rule: i, matched: 0, already: 0, assigned: 0, failed: 0 })),
    })),
    progress: { workspacesDone: 0, inboxesRead: 0, assigned: 0, already: 0, failed: 0, tagsCreated: 0 },
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

function pushError(rec: InboxTagsJob, text: string) {
  if (rec.errors.length < MAX_STORED_ERRORS) rec.errors.push(text);
  else rec.errorsTruncated = true;
}

function toInbox(a: Record<string, unknown>): InboxLite {
  const payload = (a.payload ?? {}) as Record<string, unknown>;
  const rawTags = Array.isArray(payload.tags) ? payload.tags : Array.isArray(a.tags) ? a.tags : [];
  return {
    id: String(a.id ?? a._id ?? ""),
    email: String(a.email ?? ""),
    provider: a.provider ? String(a.provider) : undefined,
    tags: (rawTags as unknown[]).map((t) => (t && typeof t === "object" ? String((t as { id?: unknown; _id?: unknown }).id ?? (t as { _id?: unknown })._id ?? "") : String(t))).filter(Boolean),
  };
}

async function readPage(apiKey: string, workspaceId: string, skip: number, limit: number): Promise<InboxLite[]> {
  await acquireSlot();
  const data = await plusvibeGet<{ accounts?: Record<string, unknown>[] }>({
    apiKey,
    path: "/account/list",
    query: { workspace_id: workspaceId, skip: String(skip), limit: String(limit) },
  });
  return (Array.isArray(data?.accounts) ? data.accounts : []).map(toInbox);
}

/** Finds the rule's tag in the workspace, creating it when missing. */
async function resolveTag(
  apiKey: string,
  workspaceId: string,
  existing: { id: string; name: string }[],
  name: string,
  color: string
): Promise<{ id: string; created: boolean }> {
  const found = findExisting(name, existing);
  if (found) return { id: found.id, created: false };
  await acquireSlot();
  try {
    const res = await plusvibePost<{ tag_id?: string; id?: string; _id?: string }>({
      apiKey,
      path: "/tags/create",
      body: { workspace_id: workspaceId, name, color },
    });
    const id = String(res?.tag_id ?? res?.id ?? res?._id ?? "");
    if (id) return { id, created: true };
  } catch (err) {
    // Created by someone in the meantime: read again rather than fail.
    if (classifyApiError(msg(err)) !== "already") throw err;
  }
  await acquireSlot();
  const again = findExisting(name, await listTags(apiKey, workspaceId));
  if (!again) throw new Error(`Created the tag "${name}" but could not read its id back.`);
  return { id: again.id, created: false };
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
    for (const ws of rec.workspaces) {
      check();
      try {
        await runWorkspace(rec, ws, apiKey, check, touch);
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

async function runWorkspace(
  rec: InboxTagsJob,
  ws: WorkspaceOutcome,
  apiKey: string,
  check: () => void,
  touch: () => Promise<void>
) {
  // 1. Tags: find or create each rule's tag in this workspace.
  ws.state = "tags";
  await touch();
  await acquireSlot();
  let existing;
  try {
    existing = await listTags(apiKey, ws.workspaceId);
  } catch (err) {
    throw new Error(`Could not read the workspace's tags: ${msg(err)}`);
  }
  for (const out of ws.rules) {
    check();
    const rule = rec.rules[out.rule];
    try {
      const t = await resolveTag(apiKey, ws.workspaceId, existing, rule.tagName, rule.color);
      out.tagId = t.id;
      out.created = t.created;
      if (t.created) {
        existing.push({ id: t.id, name: rule.tagName });
        rec.progress.tagsCreated += 1;
      }
    } catch (err) {
      out.error = `Could not find or create the tag "${rule.tagName}": ${msg(err)}`;
      pushError(rec, `${ws.workspaceName}: ${out.error}`);
    }
  }
  await touch();

  // 2. Inboxes: every page, counting as they arrive.
  ws.state = "fetching";
  const inboxes: InboxLite[] = [];
  for (let page = 0; page < ACCOUNTS_MAX_PAGES; page++) {
    check();
    let batch;
    try {
      batch = await readPage(apiKey, ws.workspaceId, page * ACCOUNTS_PAGE, ACCOUNTS_PAGE);
    } catch (err) {
      throw new Error(`Could not read the inboxes: ${msg(err)}`);
    }
    inboxes.push(...batch);
    ws.inboxes = inboxes.length;
    rec.progress.inboxesRead += batch.length;
    ws.providers = countProviders(inboxes);
    await touch();
    if (batch.length < ACCOUNTS_PAGE) break;
  }

  // 3. Assign, rule by rule, in chunks — each chunk moves the counters.
  ws.state = "tagging";
  await touch();
  const expected = new Map<string, string[]>();
  for (const out of ws.rules) {
    if (!out.tagId) continue;
    const rule = rec.rules[out.rule];
    const plan = planRule(rule, out.tagId, inboxes);
    out.matched = plan.matched;
    out.already = plan.already;
    rec.progress.already += plan.already;
    for (const ids of chunk(plan.toAssign, ASSIGN_CHUNK)) {
      check();
      try {
        await acquireSlot();
        await plusvibePut({
          apiKey,
          path: "/account/bulk-assign-tags",
          body: { workspace_id: ws.workspaceId, ids, tag_id: out.tagId, action: "ASSIGN" },
        });
        out.assigned += ids.length;
        rec.progress.assigned += ids.length;
        for (const i of ids) expected.set(i, [...(expected.get(i) ?? []), out.tagId]);
      } catch (err) {
        out.failed += ids.length;
        rec.progress.failed += ids.length;
        const text = `Assigning "${rule.tagName}" to ${ids.length} inbox${ids.length === 1 ? "" : "es"} failed: ${msg(err)}`;
        out.error = out.error ? `${out.error} ${text}` : text;
        pushError(rec, `${ws.workspaceName}: ${text}`);
      }
      await touch();
    }
  }

  // 4. Verify on a sample: nothing lost a tag, and what was sent has arrived.
  if (expected.size > 0) {
    ws.state = "verifying";
    await touch();
    try {
      const after = await readPage(apiKey, ws.workspaceId, 0, Math.min(VERIFY_SAMPLE, ACCOUNTS_PAGE));
      const v = verifyTags(inboxes, after, expected);
      ws.verified = { checked: v.checked, lostTags: v.lostTags.length, missingTag: v.missingTag.length };
      if (v.lostTags.length > 0) {
        pushError(
          rec,
          `${ws.workspaceName}: ${v.lostTags.length} inbox${v.lostTags.length === 1 ? "" : "es"} read back with a tag missing that it had before (${v.lostTags.slice(0, 3).join(", ")}${v.lostTags.length > 3 ? ", …" : ""}).`
        );
      }
      if (v.missingTag.length > 0) {
        pushError(
          rec,
          `${ws.workspaceName}: ${v.missingTag.length} inbox${v.missingTag.length === 1 ? "" : "es"} read back without the tag just assigned (${v.missingTag.slice(0, 3).join(", ")}${v.missingTag.length > 3 ? ", …" : ""}).`
        );
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

export async function listJobs(apiKey: string): Promise<InboxTagsJob[]> {
  await loadOnce();
  const fp = fingerprintKey(apiKey);
  const out: InboxTagsJob[] = [];
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

export type { RuleOutcome, WorkspaceOutcome };
