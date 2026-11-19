import "server-only";

import { createHash, randomUUID } from "crypto";
import { promises as fs, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { onShutdownFlush } from "@/lib/jobs/shutdown";
import { acquireSlot } from "@/lib/jobs/rate-limit";
import { listCampaigns } from "@/lib/plusvibe-campaigns";
import { listTags } from "@/lib/plusvibe-tags";
import { resolveTag } from "@/lib/inbox-tags/api";
import { cloneWithWinners, NeedsConfirmError, PartialCloneError } from "@/lib/winning-variants/run";
import { cleanTagName } from "@/lib/winning-variants/plan";
import type { SegmentOutcome, WinnerSummary, WinningVariantsJob, WinningVariantsStartPayload } from "@/lib/jobs/winning-variants-types";
import { MAX_STORED_ERRORS } from "@/lib/jobs/winning-variants-types";

// Server-side manager for Clone Campaign with Winning Variants runs.
//
// One run = the segments ticked in one workspace. Missing tags are created
// once, up front, so no two clones race to make the same one. Then two
// segments at a time: each reads its campaigns' figures (follow-up positives
// credited to step 1), and its base campaign is duplicated with only the
// winners in step 1. A segment with no winner is skipped — nothing is made.
//
// ONE RUN AT A TIME per API key. A run a restart cuts off is picked up again:
// at boot with the server's key, or the next time the page lists runs with the
// browser's. A segment cut off mid-clone is looked for by name before it is
// tried again, so a restart doesn't leave two clones.

const JOBS_BASE = process.env.JOBS_DIR || path.join(process.cwd(), ".jobs-data");
const JOBS_DIR = path.join(JOBS_BASE, "winning-variants");
const WORKERS = 2;
const NEW_TAG_COLOR = "#6366f1";

interface JobMeta {
  fingerprint: string;
  apiKey?: string;
  payload?: WinningVariantsStartPayload;
  aborted: boolean;
}

type Shared = { records: Map<string, WinningVariantsJob>; meta: Map<string, JobMeta>; loaded: boolean };
// On globalThis: instrumentation and the route handlers load this module separately.
const shared: Shared = ((globalThis as { __pvWinningVariants?: Shared }).__pvWinningVariants ??= {
  records: new Map(),
  meta: new Map(),
  loaded: false,
});
const { records, meta } = shared;

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err ?? "failed"));

function fingerprintKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

const fileFor = (id: string) => path.join(JOBS_DIR, `${id}.json`);
const live = (r: WinningVariantsJob) => r.status === "running";

async function persist(id: string) {
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m) return;
  rec.updatedAt = Date.now();
  try {
    await fs.mkdir(JOBS_DIR, { recursive: true });
    // The payload is kept so a cut-off run can go on; the key never is.
    await fs.writeFile(fileFor(id), JSON.stringify({ ...rec, fingerprint: m.fingerprint, payload: m.payload }), "utf8");
  } catch {
    // best-effort
  }
}

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
      writeFileSync(fileFor(id), JSON.stringify({ ...rec, fingerprint: m.fingerprint, payload: m.payload }), "utf8");
    } catch {
      // best-effort
    }
  }
}

onShutdownFlush(flushRunningSync);

async function loadOnce() {
  if (shared.loaded) return;
  shared.loaded = true;
  try {
    await fs.mkdir(JOBS_DIR, { recursive: true });
    for (const f of await fs.readdir(JOBS_DIR)) {
      if (!f.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(JOBS_DIR, f), "utf8")) as WinningVariantsJob & {
          fingerprint?: string;
          payload?: WinningVariantsStartPayload;
        };
        const { fingerprint = "", payload } = parsed;
        delete (parsed as { fingerprint?: string }).fingerprint;
        delete (parsed as { payload?: unknown }).payload;
        if (live(parsed)) parsed.status = "interrupted";
        parsed.segments = Array.isArray(parsed.segments) ? parsed.segments : [];
        parsed.errors = Array.isArray(parsed.errors) ? parsed.errors : [];
        records.set(parsed.id, parsed);
        meta.set(parsed.id, { fingerprint, payload, aborted: false });
      } catch {
        // skip a corrupt record
      }
    }
  } catch {
    // nothing to load
  }
}

function pushError(rec: WinningVariantsJob, e: string) {
  rec.errors.push(e);
  if (rec.errors.length > MAX_STORED_ERRORS) rec.errors.splice(0, rec.errors.length - MAX_STORED_ERRORS);
}

// --- Public API --------------------------------------------------------------

export class ActiveJobError extends Error {
  constructor(readonly activeJobId: string) {
    super("A Winning Variants run is already going for this account — let it finish or stop it first.");
    this.name = "ActiveJobError";
  }
}

function activeIdFor(fp: string): string | null {
  for (const [id, m] of meta) {
    const r = records.get(id);
    if (m.fingerprint === fp && r && live(r)) return id;
  }
  return null;
}

export async function createJob(apiKey: string, payload: WinningVariantsStartPayload): Promise<string> {
  await loadOnce();
  const fp = fingerprintKey(apiKey);
  const active = activeIdFor(fp);
  if (active) throw new ActiveJobError(active);
  const id = randomUUID();
  const now = Date.now();
  const rec: WinningVariantsJob = {
    id,
    status: "running",
    createdAt: now,
    updatedAt: now,
    workspaceId: payload.workspaceId,
    workspaceName: payload.workspaceName,
    optOut: payload.optOut,
    tagNames: [],
    segments: payload.segments.map((s) => ({ ...s, state: "pending" })),
    errors: [],
  };
  records.set(id, rec);
  meta.set(id, { fingerprint: fp, apiKey, payload, aborted: false });
  await persist(id);
  void run(id);
  return id;
}

/** The runs this key started, newest first. A cut-off run is picked up again with this key. */
export async function listJobs(apiKey: string): Promise<WinningVariantsJob[]> {
  await loadOnce();
  const fp = fingerprintKey(apiKey);
  const mine = [...records.values()].filter((r) => meta.get(r.id)?.fingerprint === fp);
  for (const r of mine) if (r.status === "interrupted" && !activeIdFor(fp)) await resumeJob(apiKey, r.id).catch(() => undefined);
  return mine.sort((a, b) => b.createdAt - a.createdAt);
}

export async function abortJob(apiKey: string, id: string): Promise<boolean> {
  await loadOnce();
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m || m.fingerprint !== fingerprintKey(apiKey)) return false;
  m.aborted = true;
  if (live(rec) || rec.status === "interrupted") {
    rec.status = "aborted";
    rec.finishedAt = Date.now();
    for (const s of rec.segments) if (s.state === "pending") Object.assign(s, { state: "skipped", note: "Stopped before this segment." });
    await persist(id);
  }
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

async function resumeJob(apiKey: string, id: string) {
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m || rec.status !== "interrupted" || !m.payload) return;
  if (m.fingerprint !== fingerprintKey(apiKey)) return;
  m.apiKey = apiKey;
  m.aborted = false;
  rec.status = "running";
  delete rec.resumeBlocked;
  await persist(id);
  void run(id);
}

/** At server start: runs a restart cut off go on with the server's key, when they were started with it. */
export async function bootResume(): Promise<void> {
  await loadOnce();
  const serverKey = process.env.PLUSVIBE_API_KEY?.trim() || null;
  const fp = serverKey ? fingerprintKey(serverKey) : null;
  for (const rec of [...records.values()].filter((r) => r.status === "interrupted").sort((a, b) => a.createdAt - b.createdAt)) {
    const m = meta.get(rec.id);
    if (!m) continue;
    if (!serverKey || m.fingerprint !== fp) {
      rec.resumeBlocked = "It will go on the next time the tool is opened.";
      await persist(rec.id);
      continue;
    }
    await resumeJob(serverKey, rec.id).catch(async (err) => {
      rec.resumeBlocked = msg(err);
      await persist(rec.id);
    });
  }
}

// --- The run -------------------------------------------------------------------

async function run(id: string) {
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m?.apiKey || !m.payload) return;
  const apiKey = m.apiKey;
  const { workspaceId, optOut } = m.payload;
  const stopped = () => m.aborted || records.get(id) !== rec;

  try {
    // Tags first, once: every clone then takes them by id.
    const tagIds = [...m.payload.tagIds];
    await acquireSlot();
    const known = await listTags(apiKey, workspaceId);
    for (const n of m.payload.newTags) {
      const name = cleanTagName(n);
      if (!name) continue;
      try {
        const r = await resolveTag(apiKey, workspaceId, known, name, NEW_TAG_COLOR);
        if (!tagIds.includes(r.id)) tagIds.push(r.id);
        if (r.created) known.push({ id: r.id, name, color: NEW_TAG_COLOR });
      } catch (err) {
        pushError(rec, `The tag "${name}" could not be created: ${msg(err)}`);
      }
    }
    const byId = new Map(known.map((t) => [t.id, t.name]));
    rec.tagNames = tagIds.map((t) => byId.get(t) ?? t);
    await persist(id);

    // A segment a restart cut off mid-clone: its clone may already exist.
    const cutOff = rec.segments.filter((s) => s.state === "running");
    if (cutOff.length > 0) {
      await acquireSlot();
      const all = await listCampaigns(apiKey, workspaceId, { campaignType: "parent" });
      for (const s of cutOff) {
        const made = all.find((c) => c.name.trim() === s.name.trim() && (c.createdAt ?? 0) >= (s.startedAt ?? rec.createdAt) - 60_000);
        if (made) Object.assign(s, { state: "done", createdId: made.id, note: "Made just before a restart, so it wasn't checked — open it in Plusvibe to confirm step 1.", finishedAt: Date.now() });
        else s.state = "pending";
      }
      await persist(id);
    }

    const next = () => rec.segments.find((s) => s.state === "pending");
    const worker = async () => {
      for (let s = next(); s && !stopped(); s = next()) {
        s.state = "running";
        s.startedAt = Date.now();
        await persist(id);
        await cloneSegment(apiKey, workspaceId, tagIds, optOut, s);
        s.finishedAt = Date.now();
        if (!stopped()) await persist(id);
      }
    };
    await Promise.all(Array.from({ length: WORKERS }, worker));
    if (stopped()) return;
    rec.status = "done";
  } catch (err) {
    if (stopped()) return;
    rec.status = "error";
    pushError(rec, msg(err));
  }
  rec.finishedAt = Date.now();
  await persist(id);
}

async function cloneSegment(apiKey: string, workspaceId: string, tagIds: string[], optOut: WinningVariantsStartPayload["optOut"], s: SegmentOutcome) {
  try {
    const res = await cloneWithWinners({
      apiKey,
      workspaceId,
      campaignId: s.baseId,
      alsoIds: s.ids.filter((x) => x !== s.baseId),
      name: s.name,
      tagIds,
      newTags: [],
      confirmEmpty: false,
      optOut,
    });
    const rows = res.plan.rows.filter((r) => r.kept && !r.sameAs);
    const top: WinnerSummary[] = [...rows]
      .sort((a, b) => b.positiveReplies - a.positiveReplies || b.replies - a.replies || a.sent - b.sent)
      .slice(0, 3)
      .map((r) => ({ variation: r.newLetter ?? r.variation, campaignName: r.campaignName, sent: r.sent, replies: r.replies, positiveReplies: r.positiveReplies }));
    Object.assign(s, {
      state: "done",
      createdId: res.createdId,
      kept: res.plan.kept,
      of: res.plan.rows.filter((r) => !r.sameAs).length,
      top,
      credited: res.followUps?.credited ?? 0,
      verified: res.verified,
      problems: res.problems,
      warnings: res.warnings,
    });
  } catch (err) {
    if (err instanceof NeedsConfirmError) {
      Object.assign(s, { state: "skipped", note: "No step-1 variant has a positive reply yet, so no clone was made." });
    } else if (err instanceof PartialCloneError) {
      Object.assign(s, { state: "error", createdId: err.createdId, note: err.message });
    } else {
      Object.assign(s, { state: "error", note: msg(err) });
    }
  }
}
