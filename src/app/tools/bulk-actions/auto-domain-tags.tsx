"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Workspace } from "@/lib/plusvibe-types";
import type { DomainTagsJob, WorkspaceOutcome } from "@/lib/jobs/domain-tags-types";
import { DEFAULT_PLATFORM_TAGS, DEFAULT_TLD_TAGS } from "@/lib/tags/domain-tags";
import { MAX_TAG_NAME_LENGTH, normalizeColor, prepareBatch, type TagInput } from "@/lib/tags/bulk-tags";
import { DEFAULT_SHEET_URL, DEFAULT_SHEET_TAB } from "@/lib/jobs/azure-warmup-types";
import { useSheetConfig } from "@/lib/use-sheet-config";
import {
  startDomainTags,
  listDomainTagsJobs,
  abortDomainTagsJob,
  deleteDomainTagsJob,
  ApiClientError,
} from "@/lib/api-client";
import { formatNumber } from "@/lib/format";
import { Spinner, RemoveJobButton } from "@/components/ui";
import { AlertIcon, CheckIcon, TagIcon, TrashIcon } from "@/components/icons";

// Auto-tags every inbox in the selected workspaces by its domain: the TLD
// tag from the email's domain, and the domain platform tag from the "Domain
// Host" column of the 📋 Domains sheet. The two tag sets are set up here and
// remembered in this browser; a workspace missing any of them gets them
// created. An inbox that already carries a tag from a set is left alone on
// that side; a domain not in the sheet still gets its TLD tag.

const POLL_MS = 2500;
const STORAGE_KEY = "pv_domain_tag_sets";

interface Row extends TagInput {
  key: number;
}
let nextKey = 1;
const toRows = (tags: TagInput[]): Row[] => tags.map((t) => ({ key: nextKey++, name: t.name, color: t.color }));

function loadSets(): { tld: Row[]; platform: Row[] } {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { tld?: TagInput[]; platform?: TagInput[] };
      if (Array.isArray(parsed.tld) && Array.isArray(parsed.platform)) {
        return { tld: toRows(parsed.tld), platform: toRows(parsed.platform) };
      }
    }
  } catch {
    // fall through to the defaults
  }
  return { tld: toRows(DEFAULT_TLD_TAGS), platform: toRows(DEFAULT_PLATFORM_TAGS) };
}

export function AutoDomainTags({
  workspaces,
  selected,
  loading,
}: {
  workspaces: Workspace[];
  selected: Set<string>;
  loading: boolean;
}) {
  const [tld, setTld] = useState<Row[]>([]);
  const [platform, setPlatform] = useState<Row[]>([]);
  const [setsReady, setSetsReady] = useState(false);
  const [open, setOpen] = useState(false);
  const { config: sheet, ready: sheetReady } = useSheetConfig();
  const [sheetUrl, setSheetUrl] = useState<string | null>(null);
  const [sheetTab, setSheetTab] = useState(DEFAULT_SHEET_TAB);
  const [jobs, setJobs] = useState<DomainTagsJob[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const lock = useRef(false);

  // The sets live in this browser, like the API key.
  useEffect(() => {
    const s = loadSets();
    setTld(s.tld);
    setPlatform(s.platform);
    setSetsReady(true);
  }, []);
  useEffect(() => {
    if (!setsReady) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ tld: tld.map(strip), platform: platform.map(strip) }));
    } catch {
      // nothing to do — the defaults come back next time
    }
  }, [tld, platform, setsReady]);
  // The synced sheet from the header wins; otherwise the known infra sheet.
  useEffect(() => {
    if (!sheetReady || sheetUrl !== null) return;
    setSheetUrl(sheet?.url ?? DEFAULT_SHEET_URL);
    setSheetTab(sheet?.tab ?? DEFAULT_SHEET_TAB);
  }, [sheetReady, sheet, sheetUrl]);

  const chosen = useMemo(
    () => workspaces.filter((w) => selected.has(w._id)).map((w) => ({ id: w._id, name: w.name })),
    [workspaces, selected]
  );
  const tldBatch = prepareBatch(tld.filter((r) => r.name.trim() !== ""));
  const platformBatch = prepareBatch(platform.filter((r) => r.name.trim() !== ""));
  const problems = tldBatch.problems.size + platformBatch.problems.size;
  const active = jobs.find((j) => j.status === "running") ?? null;
  const canStart = chosen.length > 0 && tldBatch.specs.length > 0 && problems === 0 && !busy && !active;

  const refresh = useCallback(async () => {
    try {
      setJobs((await listDomainTagsJobs()).jobs);
    } catch {
      // polling failure is not worth a banner
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const anyLive = jobs.some((j) => j.status === "running");
  useEffect(() => {
    if (!anyLive) return;
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [anyLive, refresh]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  async function start() {
    if (!canStart || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await startDomainTags({
        workspaces: chosen,
        tldTags: tldBatch.specs,
        platformTags: platformBatch.specs,
        sheetUrl: (sheetUrl ?? "").trim() || undefined,
        sheetTab: sheetTab.trim() || undefined,
      });
      setToast("Tagging… you can close this tab, the job keeps going.");
      await refresh();
    } catch (err) {
      setError(errMessage(err));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(errMessage(err));
    }
  };

  return (
    <div className="space-y-4">
      <div className="pv-card space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">Auto-tag inboxes by domain</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Every inbox gets its TLD tag from its email&apos;s domain, and its domain platform tag from the &quot;Domain
              Host&quot; column of the Domains sheet. Inboxes that already have a tag from a set are left alone on that
              side; a domain not in the sheet still gets its TLD tag. Existing tags are always kept.
            </p>
          </div>
          <button type="button" className="pv-btn-ghost text-xs" onClick={() => setOpen((v) => !v)}>
            {open ? "Hide tag sets" : "Edit tag sets"}
          </button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <TagSet
            title="TLD tags"
            hint="One per domain ending. The name is the ending itself."
            rows={tld}
            batch={tldBatch}
            open={open}
            placeholder=".com"
            onChange={setTld}
            onReset={() => setTld(toRows(DEFAULT_TLD_TAGS))}
          />
          <TagSet
            title="Domain platform tags"
            hint='Matched against the sheet&apos;s "Domain Host" column, case-insensitively.'
            rows={platform}
            batch={platformBatch}
            open={open}
            placeholder="porkbun"
            onChange={setPlatform}
            onReset={() => setPlatform(toRows(DEFAULT_PLATFORM_TAGS))}
          />
        </div>

        <div className="grid gap-2 sm:grid-cols-[1fr_180px]">
          <div>
            <label className="mb-1 block text-[11px] text-muted-foreground">Domains sheet</label>
            <input
              type="text"
              className="pv-input text-sm"
              placeholder="https://docs.google.com/spreadsheets/d/…"
              value={sheetUrl ?? ""}
              onChange={(e) => setSheetUrl(e.target.value)}
              spellCheck={false}
              aria-label="Domains sheet URL"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-muted-foreground">Tab</label>
            <input type="text" className="pv-input text-sm" value={sheetTab} onChange={(e) => setSheetTab(e.target.value)} aria-label="Domains sheet tab" />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          The sheet is read once at the start. Leave the URL empty to add TLD tags only. A workspace missing any of
          these tags gets them created first, so every workspace ends up with the same set.
        </p>

        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger">
            <AlertIcon size={16} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="pv-btn-primary disabled:opacity-50" disabled={!canStart} onClick={start}>
            {busy ? <Spinner /> : <TagIcon size={16} />}
            Auto-tag inboxes in {formatNumber(chosen.length)} workspace{chosen.length === 1 ? "" : "s"}
          </button>
          {active && <span className="text-xs text-muted-foreground">A job is running — it has to finish before another can start.</span>}
          {chosen.length === 0 && !loading && !active && <span className="text-xs text-muted-foreground">Pick some workspaces above first.</span>}
          {problems > 0 && <span className="text-xs text-warning">Fix the tag sets first.</span>}
        </div>
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-semibold">Auto-tag jobs</h2>
        {jobs.length === 0 ? (
          <p className="text-xs text-muted-foreground">No jobs yet. A job keeps going after you close this tab.</p>
        ) : (
          jobs.map((job) => (
            <JobCard key={job.id} job={job} onAbort={(id) => act(() => abortDomainTagsJob(id))} onRemove={(id) => act(() => deleteDomainTagsJob(id))} />
          ))
        )}
      </div>

      {toast && (
        <div className="fixed bottom-5 right-5 z-50 animate-fade-in">
          <div className="pv-card flex items-center gap-3 border-success/40 px-4 py-3 shadow-card">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-success/15 text-success">
              <CheckIcon size={16} />
            </span>
            <span className="text-sm font-medium">{toast}</span>
          </div>
        </div>
      )}
    </div>
  );
}

const strip = (r: Row): TagInput => ({ name: r.name, color: r.color });

function TagSet({
  title,
  hint,
  rows,
  batch,
  open,
  placeholder,
  onChange,
  onReset,
}: {
  title: string;
  hint: string;
  rows: Row[];
  batch: ReturnType<typeof prepareBatch>;
  open: boolean;
  placeholder: string;
  onChange: (rows: Row[]) => void;
  onReset: () => void;
}) {
  const filled = rows.filter((r) => r.name.trim() !== "");
  return (
    <div className="rounded-xl border border-border p-3">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-xs font-medium">
          {title} <span className="font-normal text-muted-foreground">· {formatNumber(batch.specs.length)}</span>
        </span>
        {open && (
          <span className="flex gap-1">
            <button type="button" className="pv-btn-ghost text-xs" onClick={() => onChange([...rows, { key: nextKey++, name: "", color: "#6B7280" }])}>
              + Add
            </button>
            <button type="button" className="pv-btn-ghost text-xs" onClick={onReset}>
              Reset
            </button>
          </span>
        )}
      </div>
      {!open ? (
        <div className="flex flex-wrap gap-1.5">
          {batch.specs.map((t) => (
            <span key={t.name} className="pv-chip">
              <span className="h-2 w-2 rounded-full" style={{ background: t.color }} />
              {t.name}
            </span>
          ))}
          {batch.specs.length === 0 && <span className="text-xs text-muted-foreground">none</span>}
        </div>
      ) : (
        <div className="space-y-1.5">
          <p className="text-[11px] text-muted-foreground">{hint}</p>
          {rows.map((r) => {
            const idx = filled.findIndex((f) => f.key === r.key);
            const problems = idx >= 0 ? batch.problems.get(idx) ?? [] : [];
            const dup = idx >= 0 && batch.duplicates.includes(idx);
            return (
              <div key={r.key}>
                <div className="grid grid-cols-[1fr_auto_96px_auto] items-center gap-1.5">
                  <input
                    type="text"
                    className="pv-input text-sm"
                    placeholder={placeholder}
                    value={r.name}
                    maxLength={MAX_TAG_NAME_LENGTH * 2}
                    onChange={(e) => onChange(rows.map((x) => (x.key === r.key ? { ...x, name: e.target.value } : x)))}
                    aria-label={`${title} name`}
                  />
                  <input
                    type="color"
                    className="h-9 w-10 cursor-pointer rounded-lg border border-border bg-transparent p-0.5"
                    value={normalizeColor(r.color) ?? "#000000"}
                    onChange={(e) => onChange(rows.map((x) => (x.key === r.key ? { ...x, color: e.target.value } : x)))}
                    title="Colour, used when the tag has to be created"
                  />
                  <input
                    type="text"
                    className="pv-input font-mono text-xs"
                    value={r.color}
                    onChange={(e) => onChange(rows.map((x) => (x.key === r.key ? { ...x, color: e.target.value } : x)))}
                    spellCheck={false}
                    aria-label={`${title} colour`}
                  />
                  <button type="button" className="pv-btn-ghost text-xs" onClick={() => onChange(rows.filter((x) => x.key !== r.key))} title="Remove">
                    <TrashIcon size={14} />
                  </button>
                </div>
                {problems.length > 0 && <p className="mt-1 text-xs text-warning">{problems.join(" ")}</p>}
                {dup && <p className="mt-1 text-xs text-muted-foreground">Repeated — only the first counts.</p>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const STATUS: Record<DomainTagsJob["status"], { label: string; className: string }> = {
  running: { label: "Running", className: "bg-accent/10 text-accent" },
  done: { label: "Done", className: "bg-success/10 text-success" },
  aborted: { label: "Stopped", className: "bg-muted text-muted-foreground" },
  interrupted: { label: "Interrupted", className: "bg-warning/10 text-warning" },
  error: { label: "Error", className: "bg-danger/10 text-danger" },
};

const WS_STATE: Record<WorkspaceOutcome["state"], string> = {
  pending: "waiting",
  tags: "checking tags",
  fetching: "reading inboxes",
  tagging: "tagging",
  verifying: "checking",
  done: "done",
  error: "failed",
};

function wsFraction(w: WorkspaceOutcome): number {
  switch (w.state) {
    case "pending":
      return 0;
    case "tags":
      return 0.1;
    case "fetching":
      return 0.3;
    case "tagging": {
      const planned = w.counts.tldAssign + w.counts.platformAssign;
      return 0.5 + (planned > 0 ? ((w.assigned + w.failed) / planned) * 0.4 : 0.4);
    }
    case "verifying":
      return 0.95;
    default:
      return 1;
  }
}

function JobCard({
  job,
  onAbort,
  onRemove,
}: {
  job: DomainTagsJob;
  onAbort: (id: string) => void | Promise<void>;
  onRemove: (id: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const s = STATUS[job.status] ?? STATUS.error;
  const liveNow = job.status === "running";
  const p = job.progress;
  const totalWs = job.workspaces.length;
  const pct = liveNow ? (totalWs > 0 ? Math.round((job.workspaces.reduce((n, w) => n + wsFraction(w), 0) / totalWs) * 100) : 0) : 100;
  const current = job.workspaces.find((w) => w.state !== "pending" && w.state !== "done" && w.state !== "error");
  const readingSheet = liveNow && !job.sheet;

  return (
    <div className="pv-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${s.className}`}>
            {liveNow && <Spinner size={10} />} {s.label}
          </span>
          <span className="truncate text-sm">{job.label}</span>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(job.createdAt)}</span>
      </div>

      <div className="mt-3">
        <div className="mb-1.5 flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {readingSheet
              ? "Reading the Domains sheet…"
              : liveNow
                ? `${formatNumber(p.workspacesDone)} of ${formatNumber(totalWs)} workspaces${current ? ` · ${current.workspaceName || current.workspaceId}: ${WS_STATE[current.state]}${current.state === "fetching" ? ` (${formatNumber(current.inboxes)} so far)` : ""}` : ""}`
                : `${formatNumber(p.workspacesDone)} of ${formatNumber(totalWs)} workspaces · ${formatNumber(p.inboxesRead)} inboxes read`}
          </span>
          <span className="tabular-nums">{pct}%</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-accent transition-all duration-300" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label="Inboxes read" value={p.inboxesRead} />
        <Metric label="TLD tags added" value={p.tldAssigned} tone={p.tldAssigned > 0 ? "success" : undefined} />
        <Metric label="Platform tags added" value={p.platformAssigned} tone={p.platformAssigned > 0 ? "success" : undefined} />
        <Metric label="Failed" value={p.failed} tone={p.failed > 0 ? "danger" : undefined} />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {formatNumber(p.tldHad)} already had a TLD tag · {formatNumber(p.platformHad)} already had a platform tag ·{" "}
        {formatNumber(p.notInSheet)} not in the sheet
        {p.tldNoTag > 0 && ` · ${formatNumber(p.tldNoTag)} with a TLD outside the set`}
        {p.hostNoTag > 0 && ` · ${formatNumber(p.hostNoTag)} with a host outside the set`}
        {p.tagsCreated > 0 && ` · ${formatNumber(p.tagsCreated)} tag${p.tagsCreated === 1 ? "" : "s"} created`}
        {job.sheet && (job.sheet.note ? ` · ${job.sheet.note}` : ` · sheet: ${formatNumber(job.sheet.withHost)} domains with a host`)}
      </p>
      {job.status === "interrupted" && (
        <p className="mt-3 text-xs text-warning">
          Interrupted by a server restart. Inboxes already tagged stay tagged; run it again to finish the rest — they
          will show as already tagged.
        </p>
      )}
      {job.errors.length > 0 && (
        <div className="mt-3 space-y-1">
          {job.errors.slice(0, 3).map((e, i) => (
            <p key={i} className="flex gap-1.5 text-xs text-warning">
              <AlertIcon size={13} className="mt-0.5 shrink-0" />
              <span>{e}</span>
            </p>
          ))}
          {job.errors.length > 3 && <p className="text-xs text-muted-foreground">+{job.errors.length - 3} more in the breakdown</p>}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {liveNow && (
          <button type="button" className="pv-btn-ghost" onClick={() => onAbort(job.id)}>
            Stop task
          </button>
        )}
        {!liveNow && <RemoveJobButton onRemove={() => onRemove(job.id)} />}
        <button type="button" className="pv-btn-ghost" onClick={() => setOpen((v) => !v)}>
          {open ? "Hide breakdown" : "Breakdown"}
        </button>
      </div>

      {open && (
        <div className="pv-scroll mt-3 max-h-96 space-y-3 overflow-y-auto rounded-xl border border-border p-3 text-xs">
          {job.workspaces.map((w) => (
            <div key={w.workspaceId}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">
                  {w.workspaceName || w.workspaceId}
                  {w.state !== "pending" && w.state !== "done" && w.state !== "error" && <Spinner size={10} />}
                </span>
                <span className="text-muted-foreground">
                  {w.state === "pending" ? "waiting" : `${formatNumber(w.inboxes)} inbox${w.inboxes === 1 ? "" : "es"}${w.state !== "done" ? ` · ${WS_STATE[w.state]}` : ""}`}
                </span>
              </div>
              {w.error && <p className="mt-1 text-danger">{w.error}</p>}
              {w.state !== "pending" && !w.error && (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <span className={`rounded-full px-2 py-0.5 ${w.counts.tldAssign > 0 ? "bg-success/10 text-success" : "bg-muted text-muted-foreground"}`}>
                    TLD: {formatNumber(w.counts.tldAssign)} added · {formatNumber(w.counts.tldHas)} had one
                    {w.counts.tldNoTag > 0 && ` · ${formatNumber(w.counts.tldNoTag)} outside the set`}
                  </span>
                  <span className={`rounded-full px-2 py-0.5 ${w.counts.platformAssign > 0 ? "bg-success/10 text-success" : "bg-muted text-muted-foreground"}`}>
                    Platform: {formatNumber(w.counts.platformAssign)} added · {formatNumber(w.counts.platformHas)} had one · {formatNumber(w.counts.notInSheet)} not in sheet
                    {w.counts.hostNoTag > 0 && ` · ${formatNumber(w.counts.hostNoTag)} host outside the set`}
                  </span>
                  {w.failed > 0 && <span className="rounded-full bg-danger/10 px-2 py-0.5 text-danger">{formatNumber(w.failed)} failed</span>}
                  {w.tagsCreated.length > 0 && <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">created: {w.tagsCreated.join(", ")}</span>}
                </div>
              )}
              {w.unknownTlds && <p className="mt-1 text-muted-foreground">TLDs with no tag: {w.unknownTlds}</p>}
              {w.unknownHosts && <p className="mt-1 text-muted-foreground">Hosts with no tag: {w.unknownHosts}</p>}
              {w.verified && (
                <p className={`mt-1 ${w.verified.lostTags > 0 || w.verified.missingTag > 0 ? "text-warning" : "text-muted-foreground"}`}>
                  Checked {formatNumber(w.verified.checked)} inbox{w.verified.checked === 1 ? "" : "es"} afterwards:{" "}
                  {w.verified.lostTags === 0 && w.verified.missingTag === 0
                    ? "existing tags intact, new tags present."
                    : `${w.verified.lostTags} lost a tag, ${w.verified.missingTag} missing a new one.`}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: "success" | "danger" }) {
  return (
    <div className="rounded-xl border border-border p-2.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold tabular-nums ${tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : ""}`}>
        {formatNumber(value)}
      </div>
    </div>
  );
}

function relativeTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function errMessage(err: unknown): string {
  return err instanceof ApiClientError ? err.message : err instanceof Error ? err.message : "Something went wrong";
}
