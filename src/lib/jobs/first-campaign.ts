import "server-only";

import { createHash, randomUUID } from "crypto";
import { promises as fs, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { onShutdownFlush } from "@/lib/jobs/shutdown";
import { acquireSlot } from "@/lib/jobs/rate-limit";
import { listCampaigns } from "@/lib/plusvibe-campaigns";
import {
  CAMPAIGN_NAME,
  SUBSEQUENCES,
  UNSETTABLE_PARENT_SETTINGS,
  SENDING_TAG_NAME,
  allSpecLabels,
  buildLabelEvent,
  buildParentUpdate,
  buildSubsequenceUpdate,
} from "@/lib/first-campaign/blueprint";
import {
  buildKeyIndex,
  keysForLabels,
  planLabels,
} from "@/lib/first-campaign/labels";
import {
  addLeadLabel,
  createCampaign,
  createSubsequence,
  findTagId,
  listLeadLabels,
  listSubsequences,
  updateCampaign,
} from "@/lib/first-campaign/api";
import type {
  FirstCampaignJob,
  FirstCampaignStartPayload,
  LabelProgress,
  SubsequenceProgress,
} from "@/lib/jobs/first-campaign-types";
import { MAX_STORED_ERRORS } from "@/lib/jobs/first-campaign-types";

// Server-side manager for "New Workspace 1st Campaign" jobs.
//
// Runs in the Node process so the work survives the tab closing, and persists
// to disk so a job can be read back later. The API key is memory-only.
//
// ONE JOB AT A TIME per API key: every phase creates something, and none of the
// create endpoints are idempotent, so two overlapping runs would leave
// duplicate labels, campaigns and sub-sequences behind.

const JOBS_BASE = process.env.JOBS_DIR || path.join(process.cwd(), ".jobs-data");
const JOBS_DIR = path.join(JOBS_BASE, "first-campaign");

interface JobMeta {
  fingerprint: string;
  apiKey?: string;
  payload?: FirstCampaignStartPayload;
  aborted: boolean;
}

const records = new Map<string, FirstCampaignJob>();
const meta = new Map<string, JobMeta>();
let loaded = false;

// --- Persistence -----------------------------------------------------------

function fingerprintKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

async function ensureDir() {
  await fs.mkdir(JOBS_DIR, { recursive: true });
}

function fileFor(id: string) {
  return path.join(JOBS_DIR, `${id}.json`);
}

async function persist(id: string) {
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m) return;
  try {
    await ensureDir();
    await fs.writeFile(
      fileFor(id),
      JSON.stringify({ ...rec, fingerprint: m.fingerprint }),
      "utf8"
    );
  } catch {
    // best-effort; a failed write must not kill the run
  }
}

function flushRunningSync() {
  if (![...records.values()].some((r) => r.status === "running")) return;
  try {
    mkdirSync(JOBS_DIR, { recursive: true });
  } catch {
    return;
  }
  for (const [id, rec] of records) {
    if (rec.status !== "running") continue;
    const m = meta.get(id);
    if (!m) continue;
    rec.status = "interrupted";
    rec.updatedAt = Date.now();
    try {
      writeFileSync(
        fileFor(id),
        JSON.stringify({ ...rec, fingerprint: m.fingerprint }),
        "utf8"
      );
    } catch {
      // best-effort
    }
  }
}

onShutdownFlush(flushRunningSync);

/**
 * Brings a persisted record up to the current shape.
 *
 * A record written by an older build is still listed rather than dropped, and
 * every array the UI iterates is defaulted — a missing field here renders as a
 * blank page, not a blank row.
 */
function migrateRecord(raw: FirstCampaignJob): FirstCampaignJob {
  const rec = raw;
  rec.errors = Array.isArray(rec.errors) ? rec.errors : [];
  rec.labels = Array.isArray(rec.labels) ? rec.labels : [];
  rec.subsequences = Array.isArray(rec.subsequences) ? rec.subsequences : [];
  for (const s of rec.subsequences) {
    // Records written before the emails existed carry no step count.
    if (typeof s.steps !== "number") s.steps = 0;
    if (!Array.isArray(s.labelNames)) s.labelNames = [];
    // The delay was days-only before the meeting confirmations needed minutes,
    // and was stored as `firstWaitDays`. Without this the card renders "+?".
    const legacy = s as unknown as { firstWaitDays?: number };
    if (typeof s.firstWait !== "number" && typeof legacy.firstWaitDays === "number") {
      s.firstWait = legacy.firstWaitDays;
      s.firstWaitUnit = "days";
      delete legacy.firstWaitDays;
    }
  }
  rec.manualFollowUps = Array.isArray(rec.manualFollowUps)
    ? rec.manualFollowUps
    : [];
  rec.parent = rec.parent ?? {
    name: rec.label ?? "",
    createState: "pending",
    settingsState: "pending",
    tagName: SENDING_TAG_NAME,
  };
  const ps = (rec.phaseStates ?? {}) as Record<string, LabelProgress["state"]>;
  rec.phaseStates = {
    labels: ps.labels ?? "pending",
    parent: ps.parent ?? "pending",
    subsequences: ps.subsequences ?? "pending",
  };
  rec.createdAt = rec.createdAt || Date.now();
  rec.updatedAt = rec.updatedAt || rec.createdAt;
  return rec;
}

async function loadOnce() {
  if (loaded) return;
  loaded = true;
  try {
    await ensureDir();
    for (const f of await fs.readdir(JOBS_DIR)) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(JOBS_DIR, f), "utf8");
        const parsed = JSON.parse(raw) as FirstCampaignJob & {
          fingerprint?: string;
        };
        const fingerprint = parsed.fingerprint ?? "";
        delete (parsed as { fingerprint?: string }).fingerprint;
        if (parsed.status === "running") {
          parsed.status = "interrupted";
          parsed.updatedAt = parsed.updatedAt || Date.now();
        }
        records.set(parsed.id, migrateRecord(parsed));
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
    super(
      "A New Workspace 1st Campaign job is already running. Wait for it to finish (or stop it) before starting another — creating campaigns and labels twice over would leave duplicates behind."
    );
    this.name = "ActiveJobError";
  }
}

export async function activeJob(
  apiKey: string
): Promise<FirstCampaignJob | null> {
  await loadOnce();
  const fp = fingerprintKey(apiKey);
  for (const [id, m] of meta) {
    if (m.fingerprint !== fp) continue;
    const rec = records.get(id);
    if (rec?.status === "running") return rec;
  }
  return null;
}

export async function createJob(
  apiKey: string,
  payload: FirstCampaignStartPayload
): Promise<string> {
  await loadOnce();

  const running = await activeJob(apiKey);
  if (running) throw new ActiveJobError(running.id);

  const id = randomUUID();
  const now = Date.now();

  const labels: LabelProgress[] = allSpecLabels().map((l) => ({
    name: l.name,
    state: "pending",
  }));

  const subsequences: SubsequenceProgress[] = SUBSEQUENCES.map((s) => ({
    name: s.name,
    labelNames: s.labels.map((l) => l.name),
    createState: "pending",
    settingsState: "pending",
    steps: s.content?.steps.length ?? 0,
    firstWait: s.content?.firstWait,
    firstWaitUnit: s.content?.firstWaitUnit,
  }));

  const record: FirstCampaignJob = {
    id,
    label: CAMPAIGN_NAME,
    status: "running",
    phase: "labels",
    phaseStates: { labels: "running", parent: "pending", subsequences: "pending" },
    createdAt: now,
    updatedAt: now,
    workspaceName: payload.workspaceName,
    labels,
    parent: {
      name: CAMPAIGN_NAME,
      createState: "pending",
      settingsState: "pending",
      tagName: SENDING_TAG_NAME,
    },
    subsequences,
    manualFollowUps: [...UNSETTABLE_PARENT_SETTINGS],
    errors: [],
  };

  records.set(id, record);
  meta.set(id, {
    fingerprint: fingerprintKey(apiKey),
    apiKey,
    payload,
    aborted: false,
  });

  await persist(id);
  void runJob(id);
  return id;
}

// --- Runner ----------------------------------------------------------------

class AbortedError extends Error {}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

function pushError(rec: FirstCampaignJob, text: string) {
  if (rec.errors.length < MAX_STORED_ERRORS) rec.errors.push(text);
  else rec.errorsTruncated = true;
}

async function runJob(id: string) {
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m || !m.apiKey || !m.payload) return;

  const apiKey = m.apiKey;
  const { workspaceId } = m.payload;
  const campaignName = CAMPAIGN_NAME;
  const check = () => {
    if (m.aborted) throw new AbortedError();
  };

  try {
    // --- Phase 1: lead labels --------------------------------------------
    // The sub-sequence triggers need each label's stable key, and a brand-new
    // workspace has none of them. Existing ones are reused rather than
    // recreated: the API rejects a duplicate name, and a near-duplicate would
    // leave two labels doing the same job.
    rec.phase = "labels";
    rec.phaseStates.labels = "running";
    await persist(id);

    await acquireSlot();
    const existing = await listLeadLabels(apiKey, workspaceId);
    check();

    const spec = allSpecLabels();
    const plan = planLabels(spec, existing);
    const resolved: Array<{ name: string; key: string }> = [];

    for (const match of plan.matched) {
      const row = rec.labels.find((l) => l.name === match.spec.name);
      if (row) {
        row.state = "done";
        row.key = match.existing!.key;
        row.reused = true;
      }
      resolved.push({ name: match.spec.name, key: match.existing!.key });
    }
    await persist(id);

    for (const missing of plan.missing) {
      check();
      const row = rec.labels.find((l) => l.name === missing.name);
      if (row) row.state = "running";
      await persist(id);
      try {
        await acquireSlot();
        const created = await addLeadLabel(apiKey, {
          workspaceId,
          name: missing.name,
          sentiment: missing.sentiment,
        });
        resolved.push({ name: missing.name, key: created.key });
        if (row) {
          row.state = "done";
          row.key = created.key;
          row.reused = false;
        }
      } catch (err) {
        if (err instanceof AbortedError) throw err;
        if (row) {
          row.state = "error";
          row.error = msg(err);
        }
        pushError(rec, `Lead label "${missing.name}": ${msg(err)}`);
      }
      rec.updatedAt = Date.now();
      await persist(id);
    }

    const keyIndex = buildKeyIndex(resolved);
    rec.phaseStates.labels = rec.labels.some((l) => l.state === "error")
      ? "error"
      : "done";
    await persist(id);

    // --- Phase 2: the parent campaign ------------------------------------
    check();
    rec.phase = "parent";
    rec.phaseStates.parent = "running";
    await persist(id);

    // Creating a campaign is not idempotent, so a re-run adopts a campaign of
    // the same name instead of making a second one.
    await acquireSlot();
    const campaigns = await listCampaigns(apiKey, workspaceId);
    check();
    const wantedName = campaignName.trim().toLowerCase();
    const already = campaigns.find(
      (c) => c.name.trim().toLowerCase() === wantedName
    );

    if (already) {
      rec.parent.campaignId = already.id;
      rec.parent.reused = true;
      rec.parent.createState = "done";
    } else {
      await acquireSlot();
      rec.parent.campaignId = await createCampaign(
        apiKey,
        workspaceId,
        campaignName
      );
      rec.parent.createState = "done";
    }
    rec.updatedAt = Date.now();
    await persist(id);

    // The "Active" tag stands in for the sending accounts, so the campaign's
    // senders track the tag rather than freezing today's list into it.
    check();
    // A tag problem must not abandon a campaign that has just been created —
    // the run continues without sending accounts and says so, rather than
    // leaving an empty shell behind and stopping before the sub-sequences.
    let tagId: string | null = null;
    try {
      await acquireSlot();
      tagId = await findTagId(apiKey, workspaceId, SENDING_TAG_NAME);
    } catch (err) {
      pushError(rec, `Could not read this workspace's tags: ${msg(err)}`);
    }
    if (tagId) {
      rec.parent.tagId = tagId;
    } else {
      rec.parent.tagMissing = true;
      pushError(
        rec,
        `No "${SENDING_TAG_NAME}" tag attached, so the campaign has no sending accounts. Add the tag (or pick accounts) before launching.`
      );
    }
    await persist(id);

    check();
    rec.parent.settingsState = "running";
    await persist(id);
    try {
      await acquireSlot();
      const { scheduleForm } = await updateCampaign(
        apiKey,
        buildParentUpdate({
          workspaceId,
          campaignId: rec.parent.campaignId!,
          emailAccounts: tagId ? [tagId] : [],
        })
      );
      rec.parent.settingsState = "done";
      rec.parent.scheduleForm = scheduleForm;
    } catch (err) {
      if (err instanceof AbortedError) throw err;
      rec.parent.settingsState = "error";
      rec.parent.error = msg(err);
      pushError(rec, `Campaign settings: ${msg(err)}`);
    }
    rec.phaseStates.parent =
      rec.parent.settingsState === "error" ? "error" : "done";
    rec.updatedAt = Date.now();
    await persist(id);

    // --- Phase 3: sub-sequences -------------------------------------------
    check();
    rec.phase = "subsequences";
    rec.phaseStates.subsequences = "running";
    await persist(id);

    // Same reuse guard: adopt any sub-sequence already under this campaign.
    let existingSubs: Array<{ id: string; name: string }> = [];
    try {
      await acquireSlot();
      existingSubs = await listSubsequences(
        apiKey,
        workspaceId,
        rec.parent.campaignId!
      );
    } catch {
      // A failed lookup only costs the reuse guard; the run still proceeds.
    }
    const subByName = new Map(
      existingSubs.map((s) => [s.name.trim().toLowerCase(), s])
    );

    for (const spec of SUBSEQUENCES) {
      check();
      const row = rec.subsequences.find((s) => s.name === spec.name)!;
      row.createState = "running";
      await persist(id);

      try {
        const found = subByName.get(spec.name.trim().toLowerCase());
        if (found) {
          row.campaignId = found.id;
          row.reused = true;
        } else {
          const keys = keysForLabels(spec.labels, keyIndex);
          await acquireSlot();
          row.campaignId = await createSubsequence(apiKey, {
            workspaceId,
            parentCampaignId: rec.parent.campaignId!,
            name: spec.name,
            events: [buildLabelEvent(keys)],
          });
        }
        row.createState = "done";
      } catch (err) {
        if (err instanceof AbortedError) throw err;
        row.createState = "error";
        row.error = msg(err);
        pushError(rec, `Sub-sequence "${spec.name}": ${msg(err)}`);
        rec.updatedAt = Date.now();
        await persist(id);
        continue;
      }

      // Its send window and its emails — neither of which the create endpoint
      // can set. A sub-sequence whose copy isn't written yet gets the schedule
      // only, and is reported as awaiting content rather than as finished.
      check();
      row.settingsState = "running";
      await persist(id);
      try {
        await acquireSlot();
        await updateCampaign(
          apiKey,
          buildSubsequenceUpdate({
            workspaceId,
            campaignId: row.campaignId!,
            content: spec.content,
          })
        );
        row.settingsState = "done";
        // Neither of these is an error — the run did exactly what it should.
        // They belong with the other "still needs a manual pass" notes, or the
        // job would report as failed for something that went entirely to plan.
        if (!spec.content) {
          rec.manualFollowUps.push(
            `"${spec.name}" sub-sequence — trigger and schedule are set, but it has no emails yet`
          );
        } else if (spec.content.manualEdits?.length) {
          rec.manualFollowUps.push(
            `"${spec.name}" sub-sequence — replace the per-client placeholders in its copy: ${spec.content.manualEdits.join(", ")}`
          );
        }
      } catch (err) {
        if (err instanceof AbortedError) throw err;
        row.settingsState = "error";
        row.error = msg(err);
        pushError(
          rec,
          `Sub-sequence "${spec.name}" schedule/emails: ${msg(err)}`
        );
      }
      rec.updatedAt = Date.now();
      await persist(id);
    }

    rec.phaseStates.subsequences = rec.subsequences.some(
      (s) => s.createState === "error" || s.settingsState === "error"
    )
      ? "error"
      : "done";

    rec.status = rec.errors.length > 0 ? "error" : "done";
  } catch (err) {
    if (err instanceof AbortedError) {
      rec.status = "aborted";
      for (const key of ["labels", "parent", "subsequences"] as const) {
        if (rec.phaseStates[key] === "running") rec.phaseStates[key] = "skipped";
      }
    } else {
      rec.status = "error";
      pushError(rec, msg(err));
      const current = rec.phase;
      if (current !== "finished" && rec.phaseStates[current] === "running") {
        rec.phaseStates[current] = "error";
      }
    }
  } finally {
    rec.phase = "finished";
    rec.updatedAt = Date.now();
    // The key is dropped the moment the work is done, so a finished job holds
    // nothing sensitive in memory.
    m.apiKey = undefined;
    m.payload = undefined;
    await persist(id);
  }
}

// --- Query / control -------------------------------------------------------

export async function getJob(
  apiKey: string,
  id: string
): Promise<FirstCampaignJob | null> {
  await loadOnce();
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m || m.fingerprint !== fingerprintKey(apiKey)) return null;
  return rec;
}

export async function listJobs(apiKey: string): Promise<FirstCampaignJob[]> {
  await loadOnce();
  const fp = fingerprintKey(apiKey);
  const out: FirstCampaignJob[] = [];
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
  // Marked aborted before the maps are cleared, so an in-flight persist() for
  // this job is a no-op rather than resurrecting the file.
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
