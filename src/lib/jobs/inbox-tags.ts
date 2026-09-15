import "server-only";

import { createHash, randomUUID } from "crypto";
import { promises as fs, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { onShutdownFlush } from "@/lib/jobs/shutdown";
import { acquireSlot } from "@/lib/jobs/rate-limit";
import { listTags } from "@/lib/plusvibe-tags";
import { findExisting } from "@/lib/tags/bulk-tags";
import {
  ASSIGN_CHUNK,
  campaignTaggable,
  chunk,
  countBuckets,
  describeRules,
  inboxTaggable,
  isLevel,
  isTagAction,
  levelNoun,
  planRule,
  prepareRules,
  verifyTags,
  type Level,
  type TagAction,
  type Taggable,
} from "@/lib/inbox-tags/plan";
import {
  ACCOUNTS_MAX_PAGES,
  ACCOUNTS_PAGE,
  CAMPAIGNS_MAX_PAGES,
  CAMPAIGNS_PAGE,
  applyTag,
  readCampaignPage,
  readInboxPage,
  resolveTag,
} from "@/lib/inbox-tags/api";
import type {
  InboxTagsJob,
  InboxTagsStartPayload,
  RuleOutcome,
  WorkspaceOutcome,
} from "@/lib/jobs/inbox-tags-types";
import { MAX_STORED_ERRORS } from "@/lib/jobs/inbox-tags-types";

// Server-side manager for Update Inbox & Campaign Tags jobs.
//
// Runs in the background and reports as it goes: per workspace the inboxes or
// campaigns are counted page by page while they load, and each write updates
// the totals. Only the rule's own tag moves — the bulk call names one tag, so
// every other tag stays where it is, and anything already the way the rule
// wants it is left out of the call entirely.
//
// ONE JOB AT A TIME per API key. Two jobs on the same workspace would race to
// create the same tag and read stale tag lists; queuing them is simpler.

const JOBS_BASE = process.env.JOBS_DIR || path.join(process.cwd(), ".jobs-data");
const JOBS_DIR = path.join(JOBS_BASE, "inbox-tags");
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

/**
 * A record written before campaigns and removal existed, read as what it was:
 * an add on inboxes. Its per-workspace counts were called `inboxes` and
 * `providers`, which are now `found` and `buckets` — the same numbers under
 * names that fit both levels.
 */
function migrate(rec: InboxTagsJob) {
  if (!isLevel(rec.level)) rec.level = "inboxes";
  if (!isTagAction(rec.action)) rec.action = "add";
  for (const w of rec.workspaces) {
    const old = w as unknown as { inboxes?: number; providers?: Record<string, number> };
    if (typeof w.found !== "number") w.found = old.inboxes ?? 0;
    if (!w.buckets) w.buckets = old.providers ?? {};
  }
  const p = rec.progress as typeof rec.progress & { inboxesRead?: number };
  if (p && typeof p.read !== "number") p.read = p.inboxesRead ?? 0;
}

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
        migrate(parsed);
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
    super("A tagging job is already running — let it finish or stop it first.");
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

  const level: Level = isLevel(payload.level) ? payload.level : "inboxes";
  const action: TagAction = isTagAction(payload.action) ? payload.action : "add";
  const prepared = prepareRules(payload.rules, level);
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
    label: `${describeRules(prepared.rules, level, action)} · ${n} workspace${n === 1 ? "" : "s"}`,
    status: "running",
    createdAt: now,
    updatedAt: now,
    level,
    action,
    includeSubsequences: level === "campaigns" ? payload.includeSubsequences === true : undefined,
    rules: prepared.rules,
    workspaces: payload.workspaces.map((w) => ({
      workspaceId: w.id,
      workspaceName: w.name,
      state: "pending" as const,
      found: 0,
      buckets: {},
      rules: prepared.rules.map((_, i) => ({ rule: i, matched: 0, already: 0, assigned: 0, failed: 0 })),
    })),
    progress: { workspacesDone: 0, read: 0, assigned: 0, already: 0, failed: 0, tagsCreated: 0 },
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
  const level = rec.level;
  const action = rec.action;
  const one = levelNoun(level);
  const many = levelNoun(level, true);
  const plural = (n: number) => (n === 1 ? one : many);

  // 1. Tags: find each rule's tag in this workspace, creating it when adding.
  //    Removing never creates one — a tag the workspace doesn't have is a tag
  //    nothing here carries, so the rule has nothing to do.
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
    if (action === "remove") {
      const found = findExisting(rule.tagName, existing);
      if (found) out.tagId = found.id;
      else out.noTag = true;
      continue;
    }
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

  // 2. The things themselves: every page, counting as they arrive.
  ws.state = "fetching";
  const items: Taggable[] = [];
  const pageSize = level === "campaigns" ? CAMPAIGNS_PAGE : ACCOUNTS_PAGE;
  const maxPages = level === "campaigns" ? CAMPAIGNS_MAX_PAGES : ACCOUNTS_MAX_PAGES;
  for (let page = 0; page < maxPages; page++) {
    check();
    let batch: Taggable[];
    let size: number;
    try {
      if (level === "campaigns") {
        const raw = await readCampaignPage(
          apiKey,
          ws.workspaceId,
          page * pageSize,
          pageSize,
          rec.includeSubsequences === true
        );
        size = raw.length;
        // Archived campaigns are out of scope entirely, so they never reach
        // the planner — not even through "All campaigns".
        batch = raw.map(campaignTaggable).filter((c) => c.bucket !== "archived");
      } else {
        const raw = await readInboxPage(apiKey, ws.workspaceId, page * pageSize, pageSize);
        size = raw.length;
        batch = raw.map(inboxTaggable);
      }
    } catch (err) {
      throw new Error(`Could not read the ${many}: ${msg(err)}`);
    }
    items.push(...batch);
    ws.found = items.length;
    rec.progress.read += batch.length;
    ws.buckets = countBuckets(items);
    await touch();
    if (size < pageSize) break;
  }

  // 3. Write, rule by rule, in chunks — each chunk moves the counters.
  ws.state = "tagging";
  await touch();
  const expected = new Map<string, string[]>();
  for (const out of ws.rules) {
    const rule = rec.rules[out.rule];
    if (!out.tagId) {
      // Nothing to remove, but the scope is still worth reporting.
      if (out.noTag) out.matched = planRule(rule, "", items, action).matched;
      continue;
    }
    const plan = planRule(rule, out.tagId, items, action);
    out.matched = plan.matched;
    out.already = plan.already;
    rec.progress.already += plan.already;
    for (const ids of chunk(plan.toChange, ASSIGN_CHUNK)) {
      check();
      try {
        await applyTag(apiKey, ws.workspaceId, ids, out.tagId, level, action);
        out.assigned += ids.length;
        rec.progress.assigned += ids.length;
        for (const i of ids) expected.set(i, [...(expected.get(i) ?? []), out.tagId]);
      } catch (err) {
        out.failed += ids.length;
        rec.progress.failed += ids.length;
        const verb = action === "remove" ? "Removing" : "Assigning";
        const prep = action === "remove" ? "from" : "to";
        const text = `${verb} "${rule.tagName}" ${prep} ${ids.length} ${plural(ids.length)} failed: ${msg(err)}`;
        out.error = out.error ? `${out.error} ${text}` : text;
        pushError(rec, `${ws.workspaceName}: ${text}`);
      }
      await touch();
    }
  }

  // 4. Verify on a sample: no other tag moved, and the write has landed.
  if (expected.size > 0) {
    ws.state = "verifying";
    await touch();
    try {
      const sample = Math.min(VERIFY_SAMPLE, pageSize);
      const after: Taggable[] =
        level === "campaigns"
          ? (await readCampaignPage(apiKey, ws.workspaceId, 0, sample, rec.includeSubsequences === true)).map(campaignTaggable)
          : (await readInboxPage(apiKey, ws.workspaceId, 0, sample)).map(inboxTaggable);
      const v = verifyTags(items, after, expected, action);
      ws.verified = { checked: v.checked, lostTags: v.lostTags.length, missingTag: v.missingTag.length };
      if (v.lostTags.length > 0) {
        pushError(
          rec,
          `${ws.workspaceName}: ${v.lostTags.length} ${plural(v.lostTags.length)} read back with a tag missing that it had before (${v.lostTags.slice(0, 3).join(", ")}${v.lostTags.length > 3 ? ", …" : ""}).`
        );
      }
      if (v.missingTag.length > 0) {
        pushError(
          rec,
          `${ws.workspaceName}: ${v.missingTag.length} ${plural(v.missingTag.length)} read back ${action === "remove" ? "still carrying the tag just removed" : "without the tag just assigned"} (${v.missingTag.slice(0, 3).join(", ")}${v.missingTag.length > 3 ? ", …" : ""}).`
        );
      }
    } catch (err) {
      pushError(rec, `${ws.workspaceName}: tagged, but the check afterwards could not read the ${many}: ${msg(err)}`);
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
