import "server-only";

import { createHash, randomUUID } from "crypto";
import { promises as fs, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { onShutdownFlush } from "@/lib/jobs/shutdown";
import { acquireSlot } from "@/lib/jobs/rate-limit";
import { plusvibePost, plusvibePut } from "@/lib/plusvibe-server";
import { listTags } from "@/lib/plusvibe-tags";
import {
  batchUpdateCells,
  columnLetter,
  envSpreadsheetId,
  isSheetWritingConfigured,
  quoteTab,
  readTab,
} from "@/lib/google-sheets";
import { extractSheetId, fetchSheetGrid } from "@/lib/sheet";
import { DEFAULT_SHEET_TAB } from "@/lib/jobs/azure-warmup-types";
import { savePreset } from "@/lib/signatures/store";
import { buildSignature } from "@/app/tools/add-signatures/generate";
import { prepareBatch, type TagSpec } from "@/lib/tags/bulk-tags";
import { chunk, type InboxLite } from "@/lib/inbox-tags/plan";
import { ACCOUNTS_MAX_PAGES, ACCOUNTS_PAGE, assignTag, readInboxPage, resolveTag } from "@/lib/inbox-tags/api";
import { findPlatformTag, findTldTag, parseDomainHosts, planInboxes } from "@/lib/tags/domain-tags";
import { normalizeEmail } from "@/lib/start-outreach/readiness";
import {
  ACTIVE_TAG_COLOR,
  describeRun,
  domainsOf,
  parseOutreachSettings,
  planClientWrites,
  planSignatures,
  signatureFieldsUsable,
  trimFields,
  type MovingInbox,
} from "@/lib/start-outreach/plan";
import type {
  StartOutreachJob,
  StartOutreachStartPayload,
  StepKey,
  StepRecord,
} from "@/lib/jobs/start-outreach-types";
import { CHUNK, MAX_STORED_ERRORS } from "@/lib/jobs/start-outreach-types";

// Server-side manager for Start Outreach runs.
//
// One run moves the chosen inboxes from the warming workspace to the client
// workspace and then, in the client workspace: applies the sending and warmup
// settings, sets each person's signature, adds the "active" tag and the TLD /
// platform tags from the sheet, and writes the client workspace's name into
// the sheet's Client column for each domain.
//
// The move comes first and is checked: only inboxes that are actually found
// in the destination afterwards are touched by the later steps. Each later
// step records what it managed, and a failure in one does not stop the next —
// a signature that could not be set is no reason to leave the tags off.
//
// ONE JOB AT A TIME per API key.

const JOBS_BASE = process.env.JOBS_DIR || path.join(process.cwd(), ".jobs-data");
const JOBS_DIR = path.join(JOBS_BASE, "start-outreach");
/** Plusvibe's listing can lag a move by a moment; look again before giving up. */
const VERIFY_WAIT_MS = Number(process.env.START_OUTREACH_VERIFY_WAIT_MS ?? 2000);
const VERIFY_RETRIES = 2;

interface JobMeta {
  fingerprint: string;
  apiKey?: string;
  aborted: boolean;
  /** The payload lives only in memory while the job runs. */
  payload?: StartOutreachStartPayload;
}

const records = new Map<string, StartOutreachJob>();
const meta = new Map<string, JobMeta>();
let loaded = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

const live = (r: StartOutreachJob) => r.status === "running";

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
        const parsed = JSON.parse(await fs.readFile(path.join(JOBS_DIR, f), "utf8")) as StartOutreachJob & {
          fingerprint?: string;
        };
        const fingerprint = parsed.fingerprint ?? "";
        delete (parsed as { fingerprint?: string }).fingerprint;
        if (live(parsed)) parsed.status = "interrupted";
        parsed.steps = Array.isArray(parsed.steps) ? parsed.steps : [];
        parsed.errors = Array.isArray(parsed.errors) ? parsed.errors : [];
        parsed.notMoved = Array.isArray(parsed.notMoved) ? parsed.notMoved : [];
        parsed.settings = Array.isArray(parsed.settings) ? parsed.settings : [];
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
    super("A Start Outreach run is already going — let it finish or stop it first.");
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

const STEP_ORDER: StepKey[] = ["move", "verify", "settings", "signatures", "tags", "sheet"];

export async function createJob(apiKey: string, payload: StartOutreachStartPayload): Promise<string> {
  await loadOnce();
  const fp = fingerprintKey(apiKey);
  const running = activeIdFor(fp);
  if (running) throw new ActiveJobError(running);

  // Re-checked here rather than trusted from the browser: this is the last
  // point before real inboxes move.
  if (!payload.sourceWorkspaceId || !payload.destWorkspaceId) {
    throw new Error("Pick both the warming workspace and the destination.");
  }
  if (payload.sourceWorkspaceId === payload.destWorkspaceId) {
    throw new Error("The destination has to be a different workspace from the one the inboxes are warming in.");
  }
  if (payload.inboxes.length === 0) throw new Error("No inboxes to move.");
  const parsed = parseOutreachSettings(payload.settings);
  const firstProblem = Object.values(parsed.problems)[0];
  if (firstProblem) throw new Error(firstProblem);
  if (payload.signatures && !signatureFieldsUsable(payload.signatures)) {
    throw new Error("Signatures need at least one job title and one company name.");
  }

  const domains = domainsOf(payload.inboxes);
  const id = randomUUID();
  const now = Date.now();
  const steps: StepRecord[] = STEP_ORDER.map((key) => ({ key, state: "pending", done: 0, total: 0 }));
  const record: StartOutreachJob = {
    id,
    label: describeRun({
      inboxes: payload.inboxes.length,
      domains: domains.length,
      source: payload.sourceWorkspaceName,
      destination: payload.destWorkspaceName,
    }),
    status: "running",
    createdAt: now,
    updatedAt: now,
    source: { id: payload.sourceWorkspaceId, name: payload.sourceWorkspaceName },
    destination: { id: payload.destWorkspaceId, name: payload.destWorkspaceName },
    inboxes: payload.inboxes.length,
    domains: domains.length,
    steps,
    settings: parsed.summary,
    signatures: !!payload.signatures,
    activeTag: payload.activeTag,
    domainTags: !!payload.domainTags,
    sheet: payload.sheet.updateClient,
    notMoved: [],
    errors: [],
  };

  records.set(id, record);
  meta.set(id, { fingerprint: fp, apiKey, aborted: false, payload });
  await persist(id);
  void runJob(id);
  return id;
}

// --- The run ---------------------------------------------------------------

class AbortedError extends Error {}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

function pushError(rec: StartOutreachJob, text: string) {
  if (rec.errors.length < MAX_STORED_ERRORS) rec.errors.push(text);
  else rec.errorsTruncated = true;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : word.endsWith("x") ? "es" : "s"}`;
}

/** A moved inbox as the destination lists it, with the name it was chosen with. */
interface Arrived extends InboxLite {
  domain: string;
  firstName?: string;
  lastName?: string;
}

async function runJob(id: string) {
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m || !m.apiKey || !m.payload) return;
  const apiKey = m.apiKey;
  const payload = m.payload;
  const step = (key: StepKey) => rec.steps.find((s) => s.key === key)!;
  const check = () => {
    if (m.aborted) throw new AbortedError();
  };
  const touch = async () => {
    rec.updatedAt = Date.now();
    await persist(id);
  };
  const finish = (s: StepRecord, note?: string) => {
    if (note) s.note = note;
    s.state = s.error ? (s.done > 0 ? "partial" : "error") : "done";
  };
  const fail = (s: StepRecord, text: string) => {
    s.error = s.error ? `${s.error} ${text}` : text;
    pushError(rec, `${stepName(s.key)}: ${text}`);
  };

  try {
    // 1. Move -----------------------------------------------------------------
    const move = step("move");
    move.state = "running";
    move.total = payload.inboxes.length;
    await touch();
    for (const part of chunk(payload.inboxes, CHUNK)) {
      check();
      try {
        await acquireSlot();
        const res = await plusvibePost<{ moved?: number }>({
          apiKey,
          path: "/account/move-workspace",
          body: {
            workspace_id: payload.sourceWorkspaceId,
            to_workspace_id: payload.destWorkspaceId,
            ids: part.map((i) => i.id),
          },
        });
        const moved = typeof res?.moved === "number" ? res.moved : part.length;
        move.done += moved;
        if (moved < part.length) {
          fail(move, `${part.length - moved} of ${part.length} were not moved (Plusvibe skips ids it cannot find in the warming workspace).`);
        }
      } catch (err) {
        fail(move, `${plural(part.length, "inbox")} could not be moved (${part.slice(0, 3).map((i) => i.email).join(", ")}${part.length > 3 ? ", …" : ""}): ${msg(err)}`);
      }
      await touch();
    }
    finish(move, `${move.done} of ${move.total} moved`);
    await touch();
    if (move.done === 0) {
      for (const k of STEP_ORDER.slice(1)) step(k).state = "skipped";
      throw new Error("Nothing was moved, so nothing else was done.");
    }

    // 2. Verify ---------------------------------------------------------------
    const verify = step("verify");
    verify.state = "running";
    verify.total = payload.inboxes.length;
    await touch();
    let arrived: Arrived[] = [];
    try {
      const wanted = new Map(payload.inboxes.map((i) => [normalizeEmail(i.email), i] as const));
      for (let attempt = 0; attempt <= VERIFY_RETRIES; attempt++) {
        check();
        if (VERIFY_WAIT_MS > 0) await sleep(VERIFY_WAIT_MS);
        arrived = await findInDestination(apiKey, payload.destWorkspaceId, wanted, check);
        verify.done = arrived.length;
        await touch();
        if (arrived.length >= move.done) break;
      }
      const found = new Set(arrived.map((a) => normalizeEmail(a.email)));
      rec.notMoved = payload.inboxes.map((i) => i.email).filter((e) => !found.has(normalizeEmail(e)));
      if (rec.notMoved.length > 0) {
        fail(verify, `${plural(rec.notMoved.length, "inbox")} not found in ${payload.destWorkspaceName} after the move; they were left as they are.`);
      }
    } catch (err) {
      if (err instanceof AbortedError) throw err;
      fail(verify, `Could not read the destination's inboxes: ${msg(err)}`);
    }
    finish(verify, `${arrived.length} of ${payload.inboxes.length} found in ${payload.destWorkspaceName}`);
    await touch();
    if (arrived.length === 0) {
      for (const k of STEP_ORDER.slice(2)) step(k).state = "skipped";
      throw new Error("None of the moved inboxes could be found in the destination, so their settings, signatures and tags were not touched.");
    }

    const dest = payload.destWorkspaceId;
    const ids = arrived.map((a) => a.id);

    // 3. Settings -------------------------------------------------------------
    const settings = step("settings");
    settings.state = "running";
    settings.total = arrived.length;
    await touch();
    const body = parseOutreachSettings(payload.settings).body;
    for (const part of chunk(ids, CHUNK)) {
      check();
      try {
        await acquireSlot();
        await plusvibePut({ apiKey, path: "/account/bulk-update", body: { workspace_id: dest, ids: part, ...body } });
        settings.done += part.length;
      } catch (err) {
        fail(settings, `${plural(part.length, "inbox")} were not updated: ${msg(err)}`);
      }
      await touch();
    }
    finish(settings, `${settings.done} of ${settings.total} updated`);
    await touch();

    // 4. Signatures -----------------------------------------------------------
    const sig = step("signatures");
    if (!payload.signatures) {
      sig.state = "skipped";
      sig.note = "Not asked for.";
    } else {
      sig.state = "running";
      const fields = trimFields(payload.signatures);
      const plan = planSignatures(
        arrived.map((a) => ({
          id: a.id,
          email: a.email,
          domain: a.domain,
          provider: a.provider ?? "",
          firstName: a.firstName,
          lastName: a.lastName,
        }))
      );
      sig.total = plan.withName;
      await touch();
      let people = 0;
      for (const person of plan.people) {
        check();
        const built = buildSignature(fields, person.first, person.last);
        if (!built) {
          fail(sig, `No signature could be built for ${person.first} ${person.last}.`.replace(/\s+\./, "."));
          continue;
        }
        people += 1;
        for (const part of chunk(person.ids, CHUNK)) {
          check();
          try {
            await acquireSlot();
            await plusvibePut({
              apiKey,
              path: "/account/bulk-update",
              body: { workspace_id: dest, ids: part, signature: built.signature },
            });
            sig.done += part.length;
          } catch (err) {
            fail(sig, `${person.first} ${person.last}: ${plural(part.length, "inbox")} did not get the signature: ${msg(err)}`);
          }
          await touch();
        }
      }
      const noName = plan.noName > 0 ? ` · ${plural(plan.noName, "inbox")} with no first name skipped` : "";
      finish(sig, `${sig.done} inbox${sig.done === 1 ? "" : "es"} across ${plural(people, "person").replace("persons", "people")}${noName}`);
      // Remembered for the destination, so the next batch fills in the same.
      try {
        await savePreset(apiKey, dest, fields);
      } catch {
        // a convenience; not part of the run
      }
    }
    await touch();

    // 5. Tags -----------------------------------------------------------------
    const tags = step("tags");
    if (!payload.activeTag && !payload.domainTags) {
      tags.state = "skipped";
      tags.note = "Not asked for.";
    } else {
      tags.state = "running";
      await touch();
      const notes: string[] = [];
      let existing: { id: string; name: string }[] = [];
      let tagsOk = true;
      try {
        await acquireSlot();
        existing = await listTags(apiKey, dest);
      } catch (err) {
        tagsOk = false;
        fail(tags, `Could not read the destination's tags: ${msg(err)}`);
      }

      if (tagsOk && payload.activeTag) {
        try {
          const t = await resolveTag(apiKey, dest, existing, payload.activeTag, ACTIVE_TAG_COLOR);
          if (t.created) existing.push({ id: t.id, name: payload.activeTag });
          const todo = arrived.filter((a) => !a.tags.includes(t.id)).map((a) => a.id);
          let n = 0;
          for (const part of chunk(todo, CHUNK)) {
            check();
            try {
              await assignTag(apiKey, dest, part, t.id);
              n += part.length;
            } catch (err) {
              fail(tags, `"${payload.activeTag}" was not added to ${plural(part.length, "inbox")}: ${msg(err)}`);
            }
            await touch();
          }
          tags.done += n;
          notes.push(`"${payload.activeTag}" on ${n}${todo.length < arrived.length ? ` (${arrived.length - todo.length} had it)` : ""}`);
        } catch (err) {
          if (err instanceof AbortedError) throw err;
          fail(tags, `Could not find or create the "${payload.activeTag}" tag: ${msg(err)}`);
        }
      }

      if (tagsOk && payload.domainTags) {
        // The sheet's Domain Host column gives the platform; a sheet that
        // cannot be read still leaves the TLD tags to add.
        let hosts = new Map<string, string>();
        try {
          hosts = parseDomainHosts(await readDomainsTab(payload.sheet)).hosts;
        } catch (err) {
          fail(tags, `The Domain Host column could not be read, so no platform tags were added: ${msg(err)}`);
        }
        try {
          // Only the tags these domains actually need are created.
          const domains = domainsOf(arrived);
          const tldSpecs = prepareBatch(payload.domainTags.tld).specs;
          const platformSpecs = prepareBatch(payload.domainTags.platform).specs;
          const neededTld = uniqueSpecs(domains.map((d) => findTldTag(d, tldSpecs)));
          const neededPlatform = uniqueSpecs(
            domains.map((d) => {
              const h = hosts.get(d);
              return h ? findPlatformTag(h, platformSpecs) : undefined;
            })
          );
          const tldTags = await ensure(apiKey, dest, existing, neededTld);
          const platformTags = await ensure(apiKey, dest, existing, platformSpecs.length ? neededPlatform : []);
          const plan = planInboxes(arrived, tldTags, platformTags, hosts);
          const nameOf = new Map([...tldTags, ...platformTags].map((t) => [t.id, t.name]));
          let assigned = 0;
          for (const [tagId, list] of plan.assignments) {
            for (const part of chunk(list, CHUNK)) {
              check();
              try {
                await assignTag(apiKey, dest, part, tagId);
                assigned += part.length;
              } catch (err) {
                fail(tags, `"${nameOf.get(tagId) ?? tagId}" was not added to ${plural(part.length, "inbox")}: ${msg(err)}`);
              }
              await touch();
            }
          }
          tags.done += assigned;
          const c = plan.counts;
          notes.push(
            `TLD on ${c.tldAssign}${c.tldHas ? ` (${c.tldHas} had one)` : ""}${c.tldNoTag ? `, ${c.tldNoTag} with no tag for the TLD` : ""}`,
            `platform on ${c.platformAssign}${c.platformHas ? ` (${c.platformHas} had one)` : ""}${c.notInSheet ? `, ${c.notInSheet} not in the sheet` : ""}${c.hostNoTag ? `, ${c.hostNoTag} with no tag for the host` : ""}`
          );
        } catch (err) {
          if (err instanceof AbortedError) throw err;
          fail(tags, `The domain tags could not be added: ${msg(err)}`);
        }
      }
      tags.total = tags.done;
      finish(tags, notes.join(" · ") || undefined);
    }
    await touch();

    // 6. Sheet ----------------------------------------------------------------
    const sheet = step("sheet");
    if (!payload.sheet.updateClient) {
      sheet.state = "skipped";
      sheet.note = "Not asked for.";
    } else {
      sheet.state = "running";
      await touch();
      try {
        const sheetId = sheetIdFor(payload.sheet);
        if (!isSheetWritingConfigured()) throw new Error("Sheet writing is not set up on the server (GOOGLE_SERVICE_ACCOUNT_JSON).");
        if (!sheetId) throw new Error("No spreadsheet to write to: sync the sheet in the header or set SPREADSHEET_ID.");
        const tab = payload.sheet.tab?.trim() || DEFAULT_SHEET_TAB;
        const grid = await readTab(sheetId, tab);
        const plan = planClientWrites(grid, domainsOf(arrived), payload.destWorkspaceName);
        if (plan.problem) throw new Error(plan.problem);
        sheet.total = plan.writes.length;
        if (plan.writes.length > 0) {
          check();
          await batchUpdateCells(
            sheetId,
            plan.writes.map((w) => ({
              range: `${quoteTab(tab)}!${columnLetter(w.column)}${w.row}`,
              value: payload.destWorkspaceName,
            }))
          );
          sheet.done = plan.writes.length;
        }
        const bits = [`Client set to "${payload.destWorkspaceName}" on ${plural(plan.writes.length, "row")}`];
        if (plan.alreadySet.length) bits.push(`${plan.alreadySet.length} already said it`);
        if (plan.notInSheet.length) {
          bits.push(`${plural(plan.notInSheet.length, "domain")} not in the sheet: ${plan.notInSheet.slice(0, 5).join(", ")}${plan.notInSheet.length > 5 ? ", …" : ""}`);
        }
        finish(sheet, bits.join(" · "));
      } catch (err) {
        if (err instanceof AbortedError) throw err;
        fail(sheet, msg(err));
        finish(sheet);
      }
    }

    const broken = rec.steps.some((s) => s.state === "error");
    rec.status = broken && arrived.length === 0 ? "error" : "done";
  } catch (err) {
    if (err instanceof AbortedError || m.aborted) {
      rec.status = "aborted";
      for (const s of rec.steps) if (s.state === "running") s.state = "partial";
    } else {
      pushError(rec, msg(err));
      rec.status = "error";
    }
  } finally {
    rec.finishedAt = Date.now();
    rec.updatedAt = rec.finishedAt;
    // Nothing sensitive outlives the run.
    m.apiKey = undefined;
    m.payload = undefined;
    await persist(id);
  }
}

function stepName(key: StepKey): string {
  return (
    {
      move: "Move",
      verify: "Check",
      settings: "Settings",
      signatures: "Signatures",
      tags: "Tags",
      sheet: "Sheet",
    } as Record<StepKey, string>
  )[key];
}

/** Pages the destination and picks out the inboxes we sent, by address. */
async function findInDestination(
  apiKey: string,
  workspaceId: string,
  wanted: Map<string, MovingInbox>,
  check: () => void
): Promise<Arrived[]> {
  const out: Arrived[] = [];
  for (let page = 0; page < ACCOUNTS_MAX_PAGES; page++) {
    check();
    const batch = await readInboxPage(apiKey, workspaceId, page * ACCOUNTS_PAGE, ACCOUNTS_PAGE);
    for (const b of batch) {
      const sent = wanted.get(normalizeEmail(b.email));
      if (!sent || !b.id) continue;
      out.push({ ...b, email: b.email, domain: sent.domain, firstName: sent.firstName, lastName: sent.lastName });
    }
    if (batch.length < ACCOUNTS_PAGE) break;
    if (out.length >= wanted.size) break;
  }
  return out;
}

function uniqueSpecs(list: (TagSpec | undefined)[]): TagSpec[] {
  const seen = new Set<string>();
  const out: TagSpec[] = [];
  for (const s of list) {
    if (!s) continue;
    const k = s.name.trim().toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

async function ensure(
  apiKey: string,
  workspaceId: string,
  existing: { id: string; name: string }[],
  specs: TagSpec[]
): Promise<{ name: string; id: string }[]> {
  const out: { name: string; id: string }[] = [];
  for (const spec of specs) {
    const t = await resolveTag(apiKey, workspaceId, existing, spec.name, spec.color);
    out.push({ name: spec.name, id: t.id });
    if (t.created) existing.push({ id: t.id, name: spec.name });
  }
  return out;
}

function sheetIdFor(sheet: StartOutreachStartPayload["sheet"]): string | null {
  const fromUrl = sheet.url ? extractSheetId(sheet.url) : null;
  return fromUrl ?? envSpreadsheetId();
}

/**
 * The Domains tab: through the service account when set up (works for a
 * private sheet), otherwise the public CSV of the synced sheet.
 */
async function readDomainsTab(sheet: StartOutreachStartPayload["sheet"]): Promise<string[][]> {
  const tab = sheet.tab?.trim() || DEFAULT_SHEET_TAB;
  const id = sheetIdFor(sheet);
  if (isSheetWritingConfigured() && id) return readTab(id, tab);
  if (sheet.url) return fetchSheetGrid(sheet.url, tab);
  throw new Error("No sheet to read: sync the sheet in the header or set SPREADSHEET_ID.");
}

// --- Query / control -------------------------------------------------------

function owned(apiKey: string, id: string) {
  const rec = records.get(id);
  const m = meta.get(id);
  if (!rec || !m || m.fingerprint !== fingerprintKey(apiKey)) return null;
  return { rec, m };
}

export async function listJobs(apiKey: string): Promise<StartOutreachJob[]> {
  await loadOnce();
  const fp = fingerprintKey(apiKey);
  const out: StartOutreachJob[] = [];
  for (const [id, m] of meta) {
    if (m.fingerprint !== fp) continue;
    const rec = records.get(id);
    if (rec) out.push(rec);
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

/** Stops a running job. What is already done stays done. */
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
