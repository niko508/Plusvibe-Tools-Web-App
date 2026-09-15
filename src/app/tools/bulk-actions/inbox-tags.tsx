"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Workspace } from "@/lib/plusvibe-types";
import type { InboxTagsJob, WorkspaceOutcome } from "@/lib/jobs/inbox-tags-types";
import {
  LEVELS,
  describeBuckets,
  levelNoun,
  prepareRules,
  scopeLabel,
  scopesFor,
  type CatalogTag,
  type Level,
  type RuleInput,
  type Scope,
  type TagAction,
} from "@/lib/inbox-tags/plan";
import { MAX_TAG_NAME_LENGTH, normalizeColor } from "@/lib/tags/bulk-tags";
import {
  fetchTagCatalog,
  startInboxTags,
  listInboxTagsJobs,
  abortInboxTagsJob,
  deleteInboxTagsJob,
  ApiClientError,
} from "@/lib/api-client";
import { formatNumber } from "@/lib/format";
import { Spinner, RemoveJobButton } from "@/components/ui";
import { AlertIcon, CheckIcon, RefreshIcon, TagIcon, TrashIcon } from "@/components/icons";

// Moves tags on and off inboxes and campaigns.
//
// Two choices come first and shape everything under them: the LEVEL — tags on
// inboxes or tags on campaigns — and whether the job ADDS or REMOVES. The
// level decides what the rules pick from (inboxes by provider, campaigns by
// status) and which Plusvibe bulk call the job makes.
//
// Tags are picked from the ones already in use across the selected workspaces
// (or typed fresh). Adding creates the tag in a workspace that lacks it;
// removing never does — a tag a workspace doesn't have is one nothing there
// carries. Runs in the background with live progress.
//
// Only the named tag moves: the bulk call takes one tag id, so every other tag
// stays where it is, and anything already the way the rule wants it is left
// out of the call entirely.

const POLL_MS = 2500;
const NEW = "__new__";
const TYPED = "__typed__";
const PALETTE = ["#3B82F6", "#10B981", "#F59E0B", "#8B5CF6", "#EC4899", "#14B8A6", "#FF5733", "#6B7280"];

interface Row {
  key: number;
  scope: Scope;
  /** A catalogue tag name, NEW for one to create, or TYPED for one to name. */
  pick: string;
  newName: string;
  newColor: string;
}

let nextKey = 1;
function blankRow(existing: Row[], level: Level): Row {
  // Each new row takes the first scope not yet used, so "all, Google,
  // Microsoft" comes out with three clicks.
  const used = new Set(existing.map((r) => r.scope));
  const scope = scopesFor(level).find((s) => !used.has(s.key))?.key ?? "all";
  return { key: nextKey++, scope, pick: "", newName: "", newColor: PALETTE[existing.length % PALETTE.length] };
}

export function InboxTags({
  workspaces,
  selected,
  loading,
}: {
  workspaces: Workspace[];
  selected: Set<string>;
  loading: boolean;
}) {
  const [level, setLevel] = useState<Level>("inboxes");
  const [action, setAction] = useState<TagAction>("add");
  const [subseq, setSubseq] = useState(false);
  const [rows, setRows] = useState<Row[]>(() => [blankRow([], "inboxes")]);
  const [catalog, setCatalog] = useState<CatalogTag[] | null>(null);
  const [catalogFor, setCatalogFor] = useState("");
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogNote, setCatalogNote] = useState<string | null>(null);
  const [jobs, setJobs] = useState<InboxTagsJob[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const lock = useRef(false);

  const chosen = useMemo(
    () => workspaces.filter((w) => selected.has(w._id)).map((w) => ({ id: w._id, name: w.name })),
    [workspaces, selected]
  );
  const chosenIds = chosen.map((c) => c.id).join(",");

  // --- The catalogue: the tags in use across the selected workspaces ------
  const loadCatalog = useCallback(async (targets: { id: string; name: string }[], ids: string) => {
    if (targets.length === 0) {
      setCatalog(null);
      setCatalogFor("");
      return;
    }
    setCatalogBusy(true);
    setCatalogNote(null);
    try {
      const res = await fetchTagCatalog(targets);
      setCatalog(res.tags);
      setCatalogFor(ids);
      if (res.failed.length > 0) {
        setCatalogNote(
          `Could not read the tags of ${res.failed.length} workspace${res.failed.length === 1 ? "" : "s"} (${res.failed
            .slice(0, 3)
            .map((f) => f.workspaceName || f.workspaceId)
            .join(", ")}${res.failed.length > 3 ? ", …" : ""}).`
        );
      }
    } catch (err) {
      setCatalogNote(`Could not read the tags in use: ${errMessage(err)}`);
    } finally {
      setCatalogBusy(false);
    }
  }, []);
  useEffect(() => {
    if (chosenIds === catalogFor) return;
    // A short pause so ticking several workspaces makes one read, not many.
    const t = setTimeout(() => void loadCatalog(chosen, chosenIds), 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosenIds]);

  // --- The rules -----------------------------------------------------------
  const removing = action === "remove";
  const one = levelNoun(level);
  const many = levelNoun(level, true);
  const inputs: RuleInput[] = rows.map((r) => {
    if (r.pick === NEW || r.pick === TYPED) return { scope: r.scope, tagName: r.newName, color: r.newColor };
    const t = catalog?.find((c) => c.name === r.pick);
    return { scope: r.scope, tagName: t?.name ?? "", color: t?.color ?? "#6B7280" };
  });
  const prepared = prepareRules(inputs, level);
  const active = jobs.find((j) => j.status === "running") ?? null;
  const canStart = chosen.length > 0 && prepared.rules.length > 0 && prepared.problems.size === 0 && !busy && !active;

  function update(key: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  /**
   * Switching level starts the rules over: a scope belongs to one level, so
   * "Google inboxes" has no meaning once the job is about campaigns.
   */
  function pickLevel(next: Level) {
    if (next === level) return;
    setLevel(next);
    setRows([blankRow([], next)]);
  }

  /** Switching to remove drops the rows that would have created a tag. */
  function pickAction(next: TagAction) {
    if (next === action) return;
    setAction(next);
    if (next === "remove") setRows((prev) => prev.map((r) => (r.pick === NEW ? { ...r, pick: TYPED } : r)));
    else setRows((prev) => prev.map((r) => (r.pick === TYPED ? { ...r, pick: NEW } : r)));
  }

  // --- Jobs ----------------------------------------------------------------
  const refresh = useCallback(async () => {
    try {
      setJobs((await listInboxTagsJobs()).jobs);
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
      await startInboxTags({
        workspaces: chosen,
        rules: prepared.rules,
        level,
        action,
        includeSubsequences: level === "campaigns" && subseq,
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
        {/* The level comes first: it decides what the rules can pick from. */}
        <div className="grid gap-3 sm:grid-cols-2" data-choices>
          <div>
            <div className="mb-1.5 text-xs font-medium text-muted-foreground">What carries the tag</div>
            <div className="flex flex-wrap items-center gap-1.5 text-xs" role="radiogroup" aria-label="What carries the tag">
              {LEVELS.map((l) => (
                <button
                  key={l.key}
                  type="button"
                  role="radio"
                  aria-checked={level === l.key}
                  onClick={() => pickLevel(l.key)}
                  className={`pv-chip ${level === l.key ? "pv-chip-active" : "hover:text-foreground"}`}
                  title={l.hint}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-1.5 text-xs font-medium text-muted-foreground">What to do with it</div>
            <div className="flex flex-wrap items-center gap-1.5 text-xs" role="radiogroup" aria-label="What to do with it">
              {(["add", "remove"] as TagAction[]).map((a) => (
                <button
                  key={a}
                  type="button"
                  role="radio"
                  aria-checked={action === a}
                  onClick={() => pickAction(a)}
                  className={`pv-chip ${action === a ? "pv-chip-active" : "hover:text-foreground"}`}
                >
                  {a === "add" ? "Add tag" : "Remove tag"}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div>
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              Tags in use{" "}
              <span className="font-normal">
                {catalogBusy
                  ? `· reading ${formatNumber(chosen.length)} workspace${chosen.length === 1 ? "" : "s"}…`
                  : catalog
                    ? `· ${formatNumber(catalog.length)} tag${catalog.length === 1 ? "" : "s"} across ${formatNumber(chosen.length)} workspace${chosen.length === 1 ? "" : "s"}`
                    : "· pick some workspaces to read their tags"}
              </span>
            </span>
            <button
              type="button"
              className="pv-btn-ghost text-xs"
              disabled={catalogBusy || chosen.length === 0}
              onClick={() => void loadCatalog(chosen, chosenIds)}
            >
              {catalogBusy ? <Spinner size={12} /> : <RefreshIcon size={12} />}
              Reload tags
            </button>
          </div>
          {catalogNote && (
            <p className="mb-2 flex gap-1.5 text-xs text-warning">
              <AlertIcon size={13} className="mt-0.5 shrink-0" />
              <span>{catalogNote}</span>
            </p>
          )}
          {catalog && catalog.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {catalog.slice(0, 30).map((t) => (
                <span key={t.name} className="pv-chip" title={`in ${t.count} of ${chosen.length} workspaces`}>
                  <span className="h-2 w-2 rounded-full" style={{ background: t.color }} />
                  {t.name}
                  {t.count < chosen.length && <span className="text-muted-foreground">{t.count}/{chosen.length}</span>}
                </span>
              ))}
              {catalog.length > 30 && <span className="text-xs text-muted-foreground">+{catalog.length - 30} more</span>}
            </div>
          )}
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              Rules{" "}
              <span className="font-normal">
                · {formatNumber(prepared.rules.length)} ready
                {prepared.duplicates.length > 0 && ` · ${prepared.duplicates.length} repeated`}
              </span>
            </span>
            <button type="button" className="pv-btn-ghost text-xs" onClick={() => setRows((prev) => [...prev, blankRow(prev, level)])}>
              + Add another rule
            </button>
          </div>
          <div className="space-y-2">
            {rows.map((r, i) => {
              const problems = prepared.problems.get(i) ?? [];
              const dup = prepared.duplicates.includes(i);
              const isNew = r.pick === NEW;
              const isTyped = r.pick === TYPED;
              const swatch = normalizeColor(r.newColor);
              return (
                <div key={r.key} className="rounded-xl border border-border p-2.5">
                  <div
                    className={`grid gap-2 ${
                      isNew
                        ? "sm:grid-cols-[180px_1fr_1fr_150px_auto]"
                        : isTyped
                          ? "sm:grid-cols-[180px_1fr_1fr_auto]"
                          : "sm:grid-cols-[180px_1fr_auto]"
                    }`}
                  >
                    <select
                      className="pv-input text-sm"
                      value={r.scope}
                      onChange={(e) => update(r.key, { scope: e.target.value as Scope })}
                      aria-label={`Which ${many}`}
                    >
                      {scopesFor(level).map((s) => (
                        <option key={s.key} value={s.key}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                    <select
                      className="pv-input text-sm"
                      value={r.pick}
                      onChange={(e) => update(r.key, { pick: e.target.value })}
                      aria-label="Tag"
                    >
                      <option value="">{catalogBusy ? "Reading tags…" : "Pick a tag…"}</option>
                      {(catalog ?? []).map((t) => (
                        <option key={t.name} value={t.name}>
                          {t.name}
                          {chosen.length > 1 && t.count < chosen.length ? ` (in ${t.count} of ${chosen.length})` : ""}
                        </option>
                      ))}
                      {/* Removing never creates a tag, so there is nothing new to name — only
                          a name to type for a tag the list didn't read. */}
                      {removing ? (
                        <option value={TYPED}>Type a name instead…</option>
                      ) : (
                        <option value={NEW}>New tag…</option>
                      )}
                    </select>
                    {(isNew || isTyped) && (
                      <input
                        type="text"
                        className="pv-input text-sm"
                        placeholder={isTyped ? "Tag name to remove" : "New tag name"}
                        value={r.newName}
                        maxLength={MAX_TAG_NAME_LENGTH * 2}
                        onChange={(e) => update(r.key, { newName: e.target.value })}
                        aria-label={isTyped ? "Tag name to remove" : "New tag name"}
                      />
                    )}
                    {isNew && (
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          className="h-9 w-10 cursor-pointer rounded-lg border border-border bg-transparent p-0.5"
                          value={swatch ?? "#000000"}
                          onChange={(e) => update(r.key, { newColor: e.target.value })}
                          title="Colour for the new tag"
                        />
                        <input
                          type="text"
                          className="pv-input font-mono text-xs"
                          placeholder="#3B82F6"
                          value={r.newColor}
                          onChange={(e) => update(r.key, { newColor: e.target.value })}
                          spellCheck={false}
                        />
                      </div>
                    )}
                    <button
                      type="button"
                      className="pv-btn-ghost text-xs"
                      disabled={rows.length === 1}
                      onClick={() => setRows((prev) => prev.filter((x) => x.key !== r.key))}
                      title="Remove this rule"
                    >
                      <TrashIcon size={14} />
                    </button>
                  </div>
                  {problems.length > 0 && (r.pick !== "" || r.newName !== "") && !(isTyped && r.newName === "") && (
                    <p className="mt-1.5 flex gap-1.5 text-xs text-warning">
                      <AlertIcon size={13} className="mt-0.5 shrink-0" />
                      <span>{problems.join(" ")}</span>
                    </p>
                  )}
                  {dup && <p className="mt-1.5 text-xs text-muted-foreground">Same as an earlier rule — only the first runs.</p>}
                </div>
              );
            })}
          </div>
        </div>

        {level === "campaigns" && (
          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <input type="checkbox" className="h-4 w-4 accent-accent" checked={subseq} onChange={(e) => setSubseq(e.target.checked)} />
            <span>Include sub-sequences</span>
          </label>
        )}

        <p className="text-xs text-muted-foreground">
          {removing ? (
            <>
              Only the named tag comes off — every other tag on the {one} stays, and {many} that don&apos;t carry it are
              left alone. A workspace without a tag of that name has nothing to remove, so it is skipped rather than
              failed; no tag is deleted from the workspace itself.
            </>
          ) : (
            <>
              Only the named tag goes on — every other tag on the {one} stays, and {many} that already carry it are
              left alone. A workspace that doesn&apos;t have the tag yet gets it created first, so every workspace ends
              up with the same tags.
            </>
          )}{" "}
          {level === "campaigns"
            ? "Archived campaigns are never touched."
            : "The job reads every inbox in the workspace and sorts them by provider."}{" "}
          It runs in the background.
        </p>

        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger">
            <AlertIcon size={16} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="pv-btn-primary disabled:opacity-50" disabled={!canStart} onClick={start} data-start>
            {busy ? <Spinner /> : <TagIcon size={16} />}
            <span>
              {removing ? "Untag" : "Tag"} {many} in {formatNumber(chosen.length)} workspace
              {chosen.length === 1 ? "" : "s"}
            </span>
          </button>
          {active && <span className="text-xs text-muted-foreground">A job is running — it has to finish before another can start.</span>}
          {chosen.length === 0 && !loading && !active && <span className="text-xs text-muted-foreground">Pick some workspaces above first.</span>}
          {chosen.length > 0 && prepared.rules.length === 0 && !active && (
            <span className="text-xs text-muted-foreground">Pick a tag for each rule.</span>
          )}
        </div>
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-semibold">Jobs</h2>
        {jobs.length === 0 ? (
          <p className="text-xs text-muted-foreground">No jobs yet. A job keeps going after you close this tab.</p>
        ) : (
          jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              onAbort={(id) => act(() => abortInboxTagsJob(id))}
              onRemove={(id) => act(() => deleteInboxTagsJob(id))}
            />
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

const STATUS: Record<InboxTagsJob["status"], { label: string; className: string }> = {
  running: { label: "Running", className: "bg-accent/10 text-accent" },
  done: { label: "Done", className: "bg-success/10 text-success" },
  aborted: { label: "Stopped", className: "bg-muted text-muted-foreground" },
  interrupted: { label: "Interrupted", className: "bg-warning/10 text-warning" },
  error: { label: "Error", className: "bg-danger/10 text-danger" },
};

const WS_STATE: Record<WorkspaceOutcome["state"], string> = {
  pending: "waiting",
  tags: "reading tags",
  fetching: "reading inboxes",
  tagging: "tagging",
  verifying: "checking",
  done: "done",
  error: "failed",
};

/** How far along one workspace is, for the bar: each stage is a slice. */
function wsFraction(w: WorkspaceOutcome): number {
  switch (w.state) {
    case "pending":
      return 0;
    case "tags":
      return 0.1;
    case "fetching":
      return 0.3;
    case "tagging": {
      const planned = w.rules.reduce((n, r) => n + Math.max(0, r.matched - r.already), 0);
      const done = w.rules.reduce((n, r) => n + r.assigned + r.failed, 0);
      return 0.5 + (planned > 0 ? (done / planned) * 0.4 : 0.4);
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
  job: InboxTagsJob;
  onAbort: (id: string) => void | Promise<void>;
  onRemove: (id: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const s = STATUS[job.status] ?? STATUS.error;
  const liveNow = job.status === "running";
  const p = job.progress;
  // Jobs from before campaigns existed have neither field; they were adds on
  // inboxes, and the server reads them back that way.
  const level = job.level ?? "inboxes";
  const removing = job.action === "remove";
  const many = levelNoun(level, true);
  const totalWs = job.workspaces.length;
  const pct = liveNow
    ? totalWs > 0 ? Math.round((job.workspaces.reduce((n, w) => n + wsFraction(w), 0) / totalWs) * 100) : 0
    : 100;
  const current = job.workspaces.find((w) => w.state !== "pending" && w.state !== "done" && w.state !== "error");

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
            {liveNow
              ? `${formatNumber(p.workspacesDone)} of ${formatNumber(totalWs)} workspaces${current ? ` · ${current.workspaceName || current.workspaceId}: ${WS_STATE[current.state]}${current.state === "fetching" ? ` (${formatNumber(current.found)} so far)` : ""}` : ""}`
              : `${formatNumber(p.workspacesDone)} of ${formatNumber(totalWs)} workspaces · ${formatNumber(p.read)} ${many} read`}
          </span>
          <span className="tabular-nums">{pct}%</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-accent transition-all duration-300" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label={`${many[0].toUpperCase()}${many.slice(1)} read`} value={p.read} />
        <Metric label={removing ? "Untagged" : "Tagged"} value={p.assigned} tone={p.assigned > 0 ? "success" : undefined} />
        <Metric label={removing ? "Didn't have it" : "Already had it"} value={p.already} />
        <Metric label="Failed" value={p.failed} tone={p.failed > 0 ? "danger" : undefined} />
      </div>
      {p.tagsCreated > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {formatNumber(p.tagsCreated)} tag{p.tagsCreated === 1 ? "" : "s"} created in workspaces that didn&apos;t have {p.tagsCreated === 1 ? "it" : "them"} yet.
        </p>
      )}
      {job.status === "interrupted" && (
        <p className="mt-3 text-xs text-warning">
          Interrupted by a server restart. Whatever was written stays written; run the same rules again to finish the
          rest — the ones already done will show as needing nothing.
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
                  {w.state === "pending"
                    ? "waiting"
                    : `${formatNumber(w.found)} ${w.found === 1 ? levelNoun(level) : many}${describeBuckets(level, w.buckets ?? {}) ? ` · ${describeBuckets(level, w.buckets ?? {})}` : ""}${w.state !== "done" ? ` · ${WS_STATE[w.state]}` : ""}`}
                </span>
              </div>
              {w.error && <p className="mt-1 text-danger">{w.error}</p>}
              {w.state !== "pending" && (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {w.rules.map((r) => {
                    const rule = job.rules[r.rule];
                    if (!rule) return null;
                    const tone = r.error ? "bg-danger/10 text-danger" : r.assigned > 0 ? "bg-success/10 text-success" : "bg-muted text-muted-foreground";
                    return (
                      <span key={r.rule} className={`rounded-full px-2 py-0.5 ${tone}`} title={r.error ?? ""}>
                        {scopeLabel(level, rule.scope)} → {rule.tagName}: {formatNumber(r.assigned)}{" "}
                        {removing ? "untagged" : "tagged"}
                        {r.already > 0 && ` · ${formatNumber(r.already)} ${removing ? "didn't have it" : "already"}`}
                        {r.failed > 0 && ` · ${formatNumber(r.failed)} failed`}
                        {r.created && " · tag created"}
                        {r.noTag && " · no such tag here"}
                        {r.error && !r.tagId && " · no tag"}
                      </span>
                    );
                  })}
                </div>
              )}
              {w.verified && (
                <p className={`mt-1 ${w.verified.lostTags > 0 || w.verified.missingTag > 0 ? "text-warning" : "text-muted-foreground"}`}>
                  Checked {formatNumber(w.verified.checked)} {w.verified.checked === 1 ? levelNoun(level) : many}{" "}
                  afterwards:{" "}
                  {w.verified.lostTags === 0 && w.verified.missingTag === 0
                    ? removing
                      ? "other tags intact, the tag gone."
                      : "existing tags intact, new tag present."
                    : `${w.verified.lostTags} lost another tag, ${w.verified.missingTag} ${removing ? "still carry it" : "missing the new one"}.`}
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
