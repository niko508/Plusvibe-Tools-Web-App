"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Workspace, EmailAccount } from "@/lib/plusvibe-types";
import {
  fetchWorkspaces,
  fetchAccounts,
  fetchEmailStatsBulk,
  startChangeLimits,
  listChangeLimitsJobs,
  abortChangeLimitsJob,
  deleteChangeLimitsJob,
  ApiClientError,
} from "@/lib/api-client";
import { useApiKey } from "@/lib/use-api-key";
import {
  DATE_PRESETS,
  providerBucket,
  formatNumber,
  formatPercent,
} from "@/lib/format";
import { mapPool } from "@/lib/concurrency";
import {
  BULK_CHUNK,
  chunk,
  rangeProblem as rangeProblemOf,
  ratesFromHeader,
  readBulkRow,
  sumTotals,
} from "@/lib/inbox-performance/metrics";
import {
  DEFAULT_THRESHOLDS,
  countVerdicts,
  describeSkipped,
  judge,
  parseThresholds,
  type ThresholdsInput,
} from "@/lib/change-limits/qualify";
import { bucketOf } from "@/lib/plusvibe-providers";
import {
  EMPTY_SETTINGS,
  parseSettings,
  type SettingsInput,
} from "@/lib/change-limits/settings";
import { copyToClipboard } from "@/lib/clipboard";
import { ConnectPrompt } from "@/components/connect-prompt";
import { StatCard } from "@/components/stat-card";
import { EmptyState, Spinner } from "@/components/ui";
import {
  AlertIcon,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  GaugeIcon,
  MailIcon,
  ZapIcon,
} from "@/components/icons";
import { Controls } from "./controls";
import { SettingsView } from "./settings-view";
import { InboxTable } from "./inbox-table";
import { exportJudgedCsv } from "./csv";
import { TABS, type InboxRow, type SortKey, type SortState, type Tab } from "./types";
import { JobsPanel } from "./jobs-panel";

// Change Limits with Best Performing Inboxes.
//
// Set a true reply rate for Google and for Microsoft plus a minimum number of
// sends, fetch the inboxes in the workspaces you pick, and every one is judged
// against its own provider's threshold. The ones that clear it get the five
// values from "Increase settings" applied in a background job.
//
// Every rate is replies ÷ UNIQUE LEADS CONTACTED, computed here from the
// counts. Plusvibe's own per-sent reply_rate is never used.

const THRESHOLDS_KEY = "pv_limits_thresholds";
const SETTINGS_KEY = "pv_limits_settings";
const SCOPE_KEY = "pv_limits_scope";
const DEFAULT_PRESET = "30d";

export function ChangeLimitsTool() {
  const { hasKey, ready } = useApiKey();

  const [tab, setTab] = useState<Tab>("inboxes");

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(false);
  const [scopeIds, setScopeIds] = useState<string[]>([]);
  const [scopeOpen, setScopeOpen] = useState(false);

  const initialRange = DATE_PRESETS.find((p) => p.key === DEFAULT_PRESET)!.range();
  const [start, setStart] = useState(initialRange.start);
  const [end, setEnd] = useState(initialRange.end);
  const [activePreset, setActivePreset] = useState<string | null>(DEFAULT_PRESET);

  const [thresholds, setThresholds] = useState<ThresholdsInput>(DEFAULT_THRESHOLDS);
  const [settings, setSettings] = useState<SettingsInput>(EMPTY_SETTINGS);
  const [prefsLoaded, setPrefsLoaded] = useState(false);

  const [rows, setRows] = useState<InboxRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [fetchedFor, setFetchedFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortState>({ key: "reply_rate", dir: "desc" });
  const [qualifyingOnly, setQualifyingOnly] = useState(false);
  const [copied, setCopied] = useState(false);

  const [jobs, setJobs] = useState<Awaited<ReturnType<typeof listChangeLimitsJobs>>["jobs"]>([]);
  const [starting, setStarting] = useState(false);
  const [armed, setArmed] = useState(false);
  const [highlightJobId, setHighlightJobId] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // --- Remembered preferences ----------------------------------------------
  useEffect(() => {
    try {
      const t = window.localStorage.getItem(THRESHOLDS_KEY);
      if (t) setThresholds({ ...DEFAULT_THRESHOLDS, ...JSON.parse(t) });
      const s = window.localStorage.getItem(SETTINGS_KEY);
      if (s) setSettings({ ...EMPTY_SETTINGS, ...JSON.parse(s) });
    } catch {
      // storage unavailable or corrupt — defaults stand
    }
    setPrefsLoaded(true);
  }, []);

  useEffect(() => {
    if (!prefsLoaded) return;
    try {
      window.localStorage.setItem(THRESHOLDS_KEY, JSON.stringify(thresholds));
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      window.localStorage.setItem(SCOPE_KEY, JSON.stringify(scopeIds));
    } catch {
      // storage unavailable
    }
  }, [thresholds, settings, scopeIds, prefsLoaded]);

  // --- Workspaces ----------------------------------------------------------
  const loadWorkspaces = useCallback(async () => {
    setWorkspacesLoading(true);
    setError(null);
    try {
      const res = await fetchWorkspaces();
      const list = res.workspaces ?? [];
      setWorkspaces(list);
      let remembered: string[] | null = null;
      try {
        const raw = window.localStorage.getItem(SCOPE_KEY);
        if (raw) remembered = JSON.parse(raw) as string[];
      } catch {
        // ignore
      }
      const valid = (remembered ?? []).filter((id) => list.some((w) => w._id === id));
      setScopeIds(valid.length > 0 ? valid : list.map((w) => w._id));
    } catch (err) {
      setError(errMessage(err));
      setWorkspaces([]);
    } finally {
      setWorkspacesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (ready && hasKey) void loadWorkspaces();
  }, [ready, hasKey, loadWorkspaces]);

  // --- Jobs ----------------------------------------------------------------
  const refreshJobs = useCallback(async () => {
    try {
      const res = await listChangeLimitsJobs();
      setJobs(res.jobs ?? []);
    } catch {
      // transient; keep the last known list
    }
  }, []);

  useEffect(() => {
    if (!(ready && hasKey)) return;
    void refreshJobs();
    const interval = setInterval(() => void refreshJobs(), 2500);
    return () => clearInterval(interval);
  }, [ready, hasKey, refreshJobs]);

  // --- Derived -------------------------------------------------------------
  const parsedThresholds = useMemo(() => parseThresholds(thresholds), [thresholds]);
  const parsedSettings = useMemo(() => parseSettings(settings), [settings]);
  const rangeProblem = rangeProblemOf(start, end);

  const judged = useMemo(() => {
    if (!parsedThresholds.ok) return rows;
    return rows.map((r) => {
      const j = judge(
        {
          provider: r.bucket,
          loaded: r.status === "done" && !!r.rates,
          sent: r.rates?.sent ?? 0,
          replyRate: r.rates?.replyRate ?? 0,
        },
        parsedThresholds
      );
      return { ...r, verdict: j.verdict, threshold: j.threshold };
    });
  }, [rows, parsedThresholds]);

  const counts = useMemo(
    () => countVerdicts(judged.filter((r) => r.verdict).map((r) => r.verdict!)),
    [judged]
  );
  const qualifying = useMemo(
    () => judged.filter((r) => r.verdict === "qualifies"),
    [judged]
  );
  const visibleRows = qualifyingOnly ? qualifying : judged;
  const loadedRates = judged.filter((r) => r.rates).map((r) => r.rates!);
  const totals = sumTotals(loadedRates);
  const showWorkspace = new Set(rows.map((r) => r.workspaceId)).size > 1;

  // --- Fetch: list the inboxes, then their figures -------------------------
  const fetchInboxes = useCallback(async () => {
    const targets = workspaces.filter((w) => scopeIds.includes(w._id));
    if (targets.length === 0) {
      setError("Pick at least one workspace.");
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;

    setBusy(true);
    setError(null);
    setRows([]);
    setArmed(false);
    setQualifyingOnly(false);
    setProgress({ done: 0, total: 0 });
    setPhase("Finding inboxes…");
    setFetchedFor(
      targets.length === 1 ? targets[0].name : `${targets.length} workspaces`
    );

    try {
      // 1) Every inbox in the chosen workspaces, one listing call each.
      const found: InboxRow[] = [];
      await mapPool(
        targets,
        async (ws) => {
          try {
            const res = await fetchAccounts({ workspace_id: ws._id }, signal);
            const batch = (res.accounts ?? [])
              .map((a) => toRow(a, ws))
              .filter((r): r is InboxRow => r !== null);
            found.push(...batch);
            setRows((prev) => [...prev, ...batch]);
          } catch (err) {
            if (isAbort(err)) throw err;
            setError((e) => e ?? `${ws.name}: ${errMessage(err)}`);
          }
        },
        { concurrency: 2, minSpacingMs: 250, signal }
      );

      if (found.length === 0) {
        setPhase("");
        return;
      }

      // 2) Their figures, one workspace per call, 100 inboxes at a time.
      setPhase("Loading stats…");
      setProgress({ done: 0, total: found.length });
      const byWorkspace = new Map<string, InboxRow[]>();
      for (const r of found) {
        const list = byWorkspace.get(r.workspaceId) ?? [];
        list.push(r);
        byWorkspace.set(r.workspaceId, list);
      }
      const batches: InboxRow[][] = [];
      for (const list of byWorkspace.values()) batches.push(...chunk(list, BULK_CHUNK));

      await mapPool(
        batches,
        async (batch) => {
          const ids = new Set(batch.map((r) => r.id));
          setRows((prev) =>
            prev.map((r) => (ids.has(r.id) ? { ...r, status: "loading" as const } : r))
          );
          try {
            const res = await fetchEmailStatsBulk(
              {
                workspace_id: batch[0].workspaceId,
                start_date: start,
                end_date: end,
                email_acc_ids: batch.map((r) => r.id).join(","),
                include_chart: false,
              },
              signal
            );
            const got = new Map<string, ReturnType<typeof readBulkRow>>();
            for (const raw of res.accounts ?? []) {
              const row = readBulkRow(raw);
              if (row) got.set(row.id, row);
            }
            setRows((prev) =>
              prev.map((r) => {
                if (!ids.has(r.id)) return r;
                const hit = got.get(r.id);
                if (!hit) {
                  return {
                    ...r,
                    status: "error" as const,
                    error: "No figures came back for this inbox.",
                  };
                }
                return {
                  ...r,
                  status: "done" as const,
                  rates: ratesFromHeader(hit.header),
                  error: undefined,
                };
              })
            );
          } catch (err) {
            if (isAbort(err)) throw err;
            const text = errMessage(err);
            setRows((prev) =>
              prev.map((r) =>
                ids.has(r.id) ? { ...r, status: "error" as const, error: text } : r
              )
            );
          } finally {
            if (!signal.aborted) {
              setProgress((p) => ({ ...p, done: p.done + batch.length }));
            }
          }
        },
        { concurrency: 2, minSpacingMs: 250, signal }
      );
    } catch (err) {
      if (!isAbort(err)) setError(errMessage(err));
    } finally {
      if (!controller.signal.aborted) {
        setBusy(false);
        setPhase("");
      }
    }
  }, [workspaces, scopeIds, start, end]);

  function cancelFetch() {
    abortRef.current?.abort();
    setBusy(false);
    setPhase("");
  }

  /** A different range means different figures, so what was judged is stale. */
  function resetForRange() {
    abortRef.current?.abort();
    setBusy(false);
    setPhase("");
    setRows([]);
    setFetchedFor(null);
    setArmed(false);
  }

  function handlePreset(key: string) {
    const preset = DATE_PRESETS.find((p) => p.key === key);
    if (!preset) return;
    const range = preset.range();
    setStart(range.start);
    setEnd(range.end);
    setActivePreset(key);
    resetForRange();
  }

  function handleSort(key: SortKey) {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : {
            key,
            dir:
              key === "inbox" || key === "workspace" || key === "provider" || key === "verdict"
                ? "asc"
                : "desc",
          }
    );
  }

  // --- Apply ---------------------------------------------------------------
  async function applySettings() {
    if (qualifying.length === 0 || !parsedSettings.ok) return;
    const byWorkspace = new Map<string, InboxRow[]>();
    for (const r of qualifying) {
      const list = byWorkspace.get(r.workspaceId) ?? [];
      list.push(r);
      byWorkspace.set(r.workspaceId, list);
    }
    setStarting(true);
    setError(null);
    try {
      const { jobId } = await startChangeLimits({
        settings,
        targets: Array.from(byWorkspace.entries()).map(([workspaceId, list]) => ({
          workspaceId,
          workspaceName: list[0].workspaceName,
          inboxes: list.map((r) => ({ id: r.id, email: r.email })),
        })),
      });
      setHighlightJobId(jobId);
      setTimeout(() => setHighlightJobId(null), 4000);
      setArmed(false);
      setTab("runs");
      await refreshJobs();
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setStarting(false);
    }
  }

  async function handleCopy() {
    if (await copyToClipboard(visibleRows.map((r) => r.email).join("\n"))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  // --- Render --------------------------------------------------------------
  if (!ready) return <div className="pv-card h-40 animate-pulse" />;
  if (!hasKey) return <ConnectPrompt onConnected={loadWorkspaces} />;

  const runningJob = jobs.find((j) => j.status === "running");

  return (
    <div className="space-y-5">
      {/* Menu */}
      <div role="tablist" aria-label="Sections" className="inline-flex rounded-xl border border-border p-1">
        {TABS.map((t) => {
          const active = t.key === tab;
          const badge =
            t.key === "settings" && parsedSettings.count > 0
              ? parsedSettings.count
              : t.key === "runs" && jobs.length > 0
                ? jobs.length
                : null;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.key)}
              className={`rounded-lg px-3 py-1.5 text-sm transition ${
                active
                  ? "bg-accent/10 font-medium text-accent"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.label}
              {badge !== null && (
                <span className="ml-1.5 tabular-nums opacity-60">{badge}</span>
              )}
            </button>
          );
        })}
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          <AlertIcon size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {tab === "settings" && (
        <SettingsView value={settings} onChange={setSettings} />
      )}

      {tab === "runs" && (
        <JobsPanel
          jobs={jobs}
          highlightJobId={highlightJobId}
          onAbort={async (id) => {
            await abortChangeLimitsJob(id).catch((e) => setError(errMessage(e)));
            await refreshJobs();
          }}
          onRemove={async (id) => {
            await deleteChangeLimitsJob(id).catch((e) => setError(errMessage(e)));
            await refreshJobs();
          }}
        />
      )}

      {tab === "inboxes" && (
        <>
          <Controls
            workspaces={workspaces}
            workspacesLoading={workspacesLoading}
            selected={scopeIds}
            onSelectedChange={(ids) => {
              setScopeIds(ids);
              resetForRange();
            }}
            scopeOpen={scopeOpen}
            onToggleScope={() => setScopeOpen((v) => !v)}
            start={start}
            end={end}
            activePreset={activePreset}
            onPreset={handlePreset}
            onStartChange={(v) => {
              setStart(v);
              setActivePreset(null);
              resetForRange();
            }}
            onEndChange={(v) => {
              setEnd(v);
              setActivePreset(null);
              resetForRange();
            }}
            rangeProblem={rangeProblem}
            thresholds={thresholds}
            onThresholdsChange={setThresholds}
            thresholdProblems={parsedThresholds.problems}
            onFetch={() => void fetchInboxes()}
            onCancel={cancelFetch}
            busy={busy}
            phase={phase}
          />

          {busy && progress.total > 0 && (
            <div className="pv-card p-4">
              <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                <span className="flex items-center gap-2">
                  <Spinner size={12} />
                  {phase}
                </span>
                <span className="tabular-nums">
                  {formatNumber(progress.done)} / {formatNumber(progress.total)} inboxes
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-accent transition-all duration-300"
                  style={{
                    width: `${progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0}%`,
                  }}
                />
              </div>
            </div>
          )}

          {rows.length === 0 && !busy && (
            <EmptyState icon={<GaugeIcon />} title="Nothing fetched yet">
              Set the thresholds, pick the workspaces and the date range, then
              press <strong>Fetch inboxes</strong>. Every inbox is judged
              against its own provider&apos;s reply rate, and the ones that
              clear it can be updated with the values under{" "}
              <strong>Increase settings</strong>.
            </EmptyState>
          )}

          {rows.length > 0 && (
            <>
              <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                <StatCard
                  label="Inboxes checked"
                  value={formatNumber(rows.length)}
                  sub={fetchedFor ? `across ${fetchedFor}` : undefined}
                />
                <StatCard
                  label="Qualifying"
                  value={formatNumber(counts.qualifies)}
                  sub={
                    rows.length > 0
                      ? `${formatPercent((counts.qualifies / rows.length) * 100)} of those checked`
                      : undefined
                  }
                />
                <StatCard
                  label="True reply rate"
                  value={formatPercent(totals.replyRate)}
                  sub={`${formatNumber(totals.replies)} replies ÷ ${formatNumber(totals.contacted)} contacted`}
                />
                <StatCard
                  label="Emails sent"
                  value={formatNumber(totals.sent)}
                  sub={`${formatNumber(loadedRates.length)} inbox${loadedRates.length === 1 ? "" : "es"} with figures`}
                />
              </div>

              {counts.qualifies < rows.length && (
                <p className="text-xs text-muted-foreground" data-skipped>
                  Left out: {describeSkipped(counts)}.
                </p>
              )}

              {/* Apply bar */}
              <div
                className={`pv-card p-4 sm:p-5 ${
                  qualifying.length > 0 && parsedSettings.ok ? "border-accent/40" : ""
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-[240px] flex-1">
                    <h2 className="text-sm font-semibold">
                      Apply the increase settings
                    </h2>
                    {parsedSettings.ok ? (
                      <p className="mt-1.5 text-sm text-muted-foreground">
                        {formatNumber(qualifying.length)} qualifying inbox
                        {qualifying.length === 1 ? "" : "es"} will be set to{" "}
                        {parsedSettings.summary
                          .map((s) => `${s.label.toLowerCase()} ${s.value}`)
                          .join(", ")}
                        . Nothing else on them changes.
                      </p>
                    ) : (
                      <p className="mt-1.5 text-sm text-muted-foreground">
                        Nothing is set yet. Open{" "}
                        <button
                          type="button"
                          className="text-accent underline"
                          onClick={() => setTab("settings")}
                        >
                          Increase settings
                        </button>{" "}
                        and fill in at least one value.
                      </p>
                    )}
                    {runningJob && (
                      <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Spinner size={12} />
                        A run is already going — it has to finish first.
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {armed && (
                      <button
                        type="button"
                        className="pv-btn-ghost"
                        onClick={() => setArmed(false)}
                      >
                        Cancel
                      </button>
                    )}
                    <button
                      type="button"
                      data-apply
                      className={`pv-btn ${
                        armed
                          ? "bg-danger text-white shadow-soft hover:brightness-110"
                          : "pv-btn-primary"
                      } disabled:opacity-50`}
                      disabled={
                        qualifying.length === 0 ||
                        !parsedSettings.ok ||
                        starting ||
                        !!runningJob
                      }
                      onClick={() => (armed ? void applySettings() : setArmed(true))}
                    >
                      {starting ? <Spinner /> : <ZapIcon size={16} />}
                      {armed
                        ? `Really update ${formatNumber(qualifying.length)}? Click again`
                        : `Apply to ${formatNumber(qualifying.length)} inbox${qualifying.length === 1 ? "" : "es"}`}
                    </button>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-semibold">By sending inbox</h2>
                  <button
                    type="button"
                    onClick={() => setQualifyingOnly((v) => !v)}
                    className={`pv-chip ${qualifyingOnly ? "pv-chip-active" : "hover:text-foreground"}`}
                  >
                    <CheckIcon size={13} />
                    {qualifyingOnly ? "Qualifying only" : "Filter qualifying"}
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="pv-btn-ghost"
                    disabled={visibleRows.length === 0}
                    onClick={handleCopy}
                    title="Copies the addresses shown, one per line"
                  >
                    {copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
                    <span className="hidden sm:inline">
                      {copied
                        ? "Copied!"
                        : `Copy ${formatNumber(visibleRows.length)} inbox${visibleRows.length === 1 ? "" : "es"}`}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="pv-btn-ghost"
                    disabled={visibleRows.length === 0}
                    onClick={() =>
                      exportJudgedCsv(visibleRows, {
                        scope: (qualifyingOnly ? "qualifying-" : "") + (fetchedFor ?? "inboxes"),
                        start,
                        end,
                      })
                    }
                  >
                    <DownloadIcon size={16} />
                    <span className="hidden sm:inline">Export CSV</span>
                  </button>
                </div>
              </div>
              <p className="-mt-1 text-xs text-muted-foreground">
                Rates are replies ÷ unique leads contacted, worked out here from
                the counts. Plusvibe&apos;s own per-sent reply rate is not used.
              </p>

              {visibleRows.length > 0 ? (
                <InboxTable
                  rows={visibleRows}
                  sort={sort}
                  onSort={handleSort}
                  showWorkspace={showWorkspace}
                />
              ) : (
                <EmptyState icon={<MailIcon />} title="No inboxes qualify">
                  Nothing is at or above its provider&apos;s reply rate with at
                  least {thresholds.minSends || "0"} sends in this range. Lower
                  a threshold, or widen the date range.
                </EmptyState>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

// --- Helpers ---------------------------------------------------------------

function toRow(a: EmailAccount, ws: Workspace): InboxRow | null {
  if (!a.id || !a.email) return null;
  return {
    id: a.id,
    email: a.email.trim().toLowerCase(),
    workspaceId: ws._id,
    workspaceName: ws.name,
    provider: providerBucket(a.provider),
    bucket: bucketOf(a.provider),
    accountStatus: a.status,
    status: "pending",
  };
}

function isAbort(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

function errMessage(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
