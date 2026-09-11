"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Workspace, EmailAccount } from "@/lib/plusvibe-types";
import {
  fetchWorkspaces,
  fetchAccounts,
  fetchEmailStatsBulk,
  ApiClientError,
} from "@/lib/api-client";
import { useApiKey } from "@/lib/use-api-key";
import {
  DATE_PRESETS,
  domainFromEmail,
  providerBucket,
  formatNumber,
  formatPercent,
  bounceRateHealth,
  replyRateHealth,
} from "@/lib/format";
import { mapPool } from "@/lib/concurrency";
import {
  BULK_CHUNK,
  BURNED_OOO_SAFE,
  aggregateChart,
  chunk,
  isBurned,
  rangeProblem as rangeProblemOf,
  ratesFromHeader,
  readBulkRow,
  sumTotals,
} from "@/lib/inbox-performance/metrics";
import { copyToClipboard } from "@/lib/clipboard";
import { ConnectPrompt } from "@/components/connect-prompt";
import { StatCard } from "@/components/stat-card";
import { EmptyState, Spinner } from "@/components/ui";
import {
  AlertIcon,
  DownloadIcon,
  MailIcon,
  CopyIcon,
  CheckIcon,
  FireIcon,
} from "@/components/icons";
import { Controls } from "./controls";
import { OverviewChart } from "../domain-performance/overview-chart";
import { providerLabel } from "../domain-performance/providers";
import { InboxTable } from "./inbox-table";
import { exportInboxesCsv } from "./csv";
import { ALL_WORKSPACES, type InboxRow, type SortKey, type SortState } from "./types";

// Inbox Performance Monitoring: the Domain Performance tool, one row per
// sending inbox, for one workspace or every workspace at once.
//
// Nothing is fetched on its own. The workspaces are listed so there is
// something to choose from; the inboxes are found when asked, and their stats
// loaded when asked, for the date range, provider and workspaces chosen.
//
// Every rate shown is replies ÷ UNIQUE LEADS CONTACTED, computed here from
// the counts. Plusvibe's own reply_rate divides by emails sent and reads
// several times lower once follow-ups are in play; it is never used.

const SCOPE_KEY = "pv_inbox_scope";
const BURNED_THRESHOLD_KEY = "pv_inbox_burned_threshold";
const MIN_SENDS_KEY = "pv_inbox_min_sends";
const CHART_KEY = "pv_inbox_chart";
const DEFAULT_PRESET = "30d";

export function InboxPerformanceTool() {
  const { hasKey, ready } = useApiKey();

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(false);
  const [scope, setScope] = useState<string>(ALL_WORKSPACES);

  const initialRange = DATE_PRESETS.find((p) => p.key === DEFAULT_PRESET)!.range();
  const [start, setStart] = useState(initialRange.start);
  const [end, setEnd] = useState(initialRange.end);
  const [activePreset, setActivePreset] = useState<string | null>(DEFAULT_PRESET);
  const [includeChart, setIncludeChart] = useState(true);

  const [rows, setRows] = useState<InboxRow[]>([]);
  const [findBusy, setFindBusy] = useState(false);
  const [findProgress, setFindProgress] = useState({ done: 0, total: 0, name: "" });
  const [statsBusy, setStatsBusy] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [senderProvider, setSenderProvider] = useState<string | null>(null);
  /** Global view only: narrow the results to one workspace, client-side. */
  const [workspaceFilter, setWorkspaceFilter] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sort, setSort] = useState<SortState>({ key: "sent", dir: "desc" });
  /** What the current rows were found for, so the table can say so. */
  const [foundFor, setFoundFor] = useState<{ scope: string; label: string } | null>(null);

  const [burnedOnly, setBurnedOnly] = useState(false);
  const [threshold, setThreshold] = useState("0.2");
  const [minSends, setMinSends] = useState("0");
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [copied, setCopied] = useState(false);

  // Persisted preferences, read once on the client.
  useEffect(() => {
    try {
      const t = window.localStorage.getItem(BURNED_THRESHOLD_KEY);
      if (t !== null) setThreshold(t);
      const m = window.localStorage.getItem(MIN_SENDS_KEY);
      if (m !== null) setMinSends(m);
      const c = window.localStorage.getItem(CHART_KEY);
      if (c !== null) setIncludeChart(c !== "0");
      const s = window.localStorage.getItem(SCOPE_KEY);
      if (s) setScope(s);
    } catch {
      // storage unavailable
    }
    setPrefsLoaded(true);
  }, []);
  useEffect(() => {
    if (!prefsLoaded) return;
    try {
      window.localStorage.setItem(BURNED_THRESHOLD_KEY, threshold);
      window.localStorage.setItem(MIN_SENDS_KEY, minSends);
      window.localStorage.setItem(CHART_KEY, includeChart ? "1" : "0");
      window.localStorage.setItem(SCOPE_KEY, scope);
    } catch {
      // storage unavailable
    }
  }, [threshold, minSends, includeChart, scope, prefsLoaded]);

  const findAbortRef = useRef<AbortController | null>(null);
  const statsAbortRef = useRef<AbortController | null>(null);

  // --- Workspaces: the one thing loaded without being asked ----------------
  const loadWorkspaces = useCallback(async () => {
    setWorkspacesLoading(true);
    setError(null);
    try {
      const res = await fetchWorkspaces();
      const list = res.workspaces ?? [];
      setWorkspaces(list);
      // A remembered single-workspace scope that no longer exists falls back
      // to everything rather than to a blank select.
      setScope((s) => (s === ALL_WORKSPACES || list.some((w) => w._id === s) ? s : ALL_WORKSPACES));
    } catch (err) {
      setError(errMessage(err));
      setWorkspaces([]);
    } finally {
      setWorkspacesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (ready && hasKey) void loadWorkspaces();
    else if (ready && !hasKey) {
      setWorkspaces([]);
      setRows([]);
    }
  }, [ready, hasKey, loadWorkspaces]);

  // --- Step 1: find the inboxes in scope -----------------------------------
  const findInboxes = useCallback(async () => {
    findAbortRef.current?.abort();
    statsAbortRef.current?.abort();
    const controller = new AbortController();
    findAbortRef.current = controller;
    const { signal } = controller;

    const targets = scope === ALL_WORKSPACES ? workspaces : workspaces.filter((w) => w._id === scope);
    if (targets.length === 0) return;

    setFindBusy(true);
    setStatsBusy(false);
    setError(null);
    setRows([]);
    setSelectedId(null);
    setWorkspaceFilter(null);
    setProgress({ done: 0, total: 0 });
    setFindProgress({ done: 0, total: targets.length, name: targets[0].name });
    setFoundFor({
      scope,
      label: scope === ALL_WORKSPACES ? `all ${targets.length} workspaces` : targets[0].name,
    });

    try {
      await mapPool(
        targets,
        async (ws) => {
          setFindProgress((p) => ({ ...p, name: ws.name }));
          try {
            const res = await fetchAccounts({ workspace_id: ws._id }, signal);
            const found = (res.accounts ?? []).map((a) => toRow(a, ws)).filter((r): r is InboxRow => r !== null);
            setRows((prev) => [...prev, ...found]);
          } catch (err) {
            if (isAbort(err)) throw err;
            setError((e) => e ?? `${ws.name}: ${errMessage(err)}`);
          } finally {
            if (!signal.aborted) setFindProgress((p) => ({ ...p, done: p.done + 1 }));
          }
        },
        { concurrency: 2, minSpacingMs: 250, signal }
      );
    } catch (err) {
      if (!isAbort(err)) setError(errMessage(err));
    } finally {
      if (!controller.signal.aborted) setFindBusy(false);
    }
  }, [scope, workspaces]);

  // --- Step 2: stats for the inboxes in scope, 100 per call ----------------
  const loadStats = useCallback(
    async (targets: InboxRow[]) => {
      const todo = targets.filter((r) => r.status === "pending" || r.status === "error");
      if (todo.length === 0) return;

      statsAbortRef.current?.abort();
      const controller = new AbortController();
      statsAbortRef.current = controller;
      const { signal } = controller;

      setStatsBusy(true);
      setError(null);
      setProgress({ done: 0, total: todo.length });

      // One workspace per call, so group first, then chunk to the limit.
      const byWorkspace = new Map<string, InboxRow[]>();
      for (const r of todo) {
        const list = byWorkspace.get(r.workspaceId) ?? [];
        list.push(r);
        byWorkspace.set(r.workspaceId, list);
      }
      const batches: InboxRow[][] = [];
      for (const list of byWorkspace.values()) batches.push(...chunk(list, BULK_CHUNK));

      try {
        await mapPool(
          batches,
          async (batch) => {
            const ids = new Set(batch.map((r) => r.id));
            patchRows(setRows, ids, { status: "loading" });
            try {
              const res = await fetchEmailStatsBulk(
                {
                  workspace_id: batch[0].workspaceId,
                  start_date: start,
                  end_date: end,
                  email_acc_ids: batch.map((r) => r.id).join(","),
                  include_chart: includeChart,
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
                    return { ...r, status: "error", error: "No figures came back for this inbox." };
                  }
                  return {
                    ...r,
                    status: "done",
                    header: hit.header,
                    chart: hit.chart,
                    rates: ratesFromHeader(hit.header),
                    error: undefined,
                  };
                })
              );
            } catch (err) {
              if (isAbort(err)) throw err;
              patchRows(setRows, ids, { status: "error", error: errMessage(err) });
            } finally {
              if (!signal.aborted) setProgress((p) => ({ ...p, done: p.done + batch.length }));
            }
          },
          { concurrency: 2, minSpacingMs: 250, signal }
        );
      } catch (err) {
        if (!isAbort(err)) setError(errMessage(err));
      } finally {
        if (!controller.signal.aborted) setStatsBusy(false);
      }
    },
    [start, end, includeChart]
  );

  /** Drops loaded stats, keeping the inbox list. */
  const invalidateStats = useCallback(() => {
    statsAbortRef.current?.abort();
    setStatsBusy(false);
    setSelectedId(null);
    setProgress({ done: 0, total: 0 });
    setRows((prev) =>
      prev.map((r) => ({ ...r, status: "pending" as const, header: undefined, chart: undefined, rates: undefined, error: undefined }))
    );
  }, []);

  // --- Handlers ------------------------------------------------------------
  function handleScopeChange(v: string) {
    setScope(v);
    // A different scope is a different set of inboxes; what was found is
    // stale, and a Find is one click away.
    findAbortRef.current?.abort();
    statsAbortRef.current?.abort();
    setFindBusy(false);
    setStatsBusy(false);
    setRows([]);
    setFoundFor(null);
    setSelectedId(null);
    setWorkspaceFilter(null);
  }

  function handlePreset(key: string) {
    const preset = DATE_PRESETS.find((p) => p.key === key);
    if (!preset) return;
    const range = preset.range();
    setStart(range.start);
    setEnd(range.end);
    setActivePreset(key);
    invalidateStats();
  }

  function handleSort(key: SortKey) {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "inbox" || key === "workspace" || key === "provider" ? "asc" : "desc" }
    );
  }

  // --- Derived -------------------------------------------------------------
  const rangeProblem = rangeProblemOf(start, end);
  const isGlobal = foundFor?.scope === ALL_WORKSPACES;

  const senderCounts: Record<string, number> = {};
  for (const r of rows) senderCounts[r.provider] = (senderCounts[r.provider] ?? 0) + 1;
  const workspaceCounts = new Map<string, number>();
  for (const r of rows) workspaceCounts.set(r.workspaceId, (workspaceCounts.get(r.workspaceId) ?? 0) + 1);

  const inScope = rows.filter((r) => !senderProvider || r.provider === senderProvider);
  const toLoad = inScope.filter((r) => r.status === "pending" || r.status === "error").length;

  const minSendsNum = Math.max(1, Math.floor(Number(minSends)) || 0);
  const activeRows = rows.filter((r) => {
    if (senderProvider && r.provider !== senderProvider) return false;
    if (workspaceFilter && r.workspaceId !== workspaceFilter) return false;
    if (r.status === "done" && r.rates && r.rates.sent < minSendsNum) return false;
    return true;
  });
  const hiddenInactive = rows.filter(
    (r) =>
      (!senderProvider || r.provider === senderProvider) &&
      (!workspaceFilter || r.workspaceId === workspaceFilter) &&
      r.status === "done" &&
      r.rates &&
      r.rates.sent < minSendsNum
  ).length;

  const loadedRows = activeRows.filter((r) => r.status === "done" && r.rates);
  const nothingLoaded = rows.length > 0 && loadedRows.length === 0 && !statsBusy;
  const summary = sumTotals(loadedRows.map((r) => r.rates!));
  const summaryLoading = statsBusy && loadedRows.length === 0;

  const thresholdNum = parseFloat(threshold);
  const thresholdValid = Number.isFinite(thresholdNum);
  const burnedRows = thresholdValid ? loadedRows.filter((r) => isBurned(r.rates!, thresholdNum)) : [];
  const burnedPct = loadedRows.length > 0 ? (burnedRows.length / loadedRows.length) * 100 : 0;
  const visibleRows = burnedOnly ? burnedRows : activeRows;

  const selectedRow = rows.find((r) => r.id === selectedId);
  const chartsLoaded = loadedRows.some((r) => r.chart && r.chart.length > 0);
  const chartData = selectedRow?.chart ?? aggregateChart(loadedRows.map((r) => r.chart ?? []));
  const chartTitle = selectedRow
    ? `${selectedRow.email} · ${start} → ${end}`
    : foundFor
      ? `${senderProvider ? providerLabel(senderProvider) + " inboxes" : "All inboxes"} · ${
          workspaceFilter ? (workspaces.find((w) => w._id === workspaceFilter)?.name ?? "") : foundFor.label
        } · ${start} → ${end}`
      : "";

  async function handleCopy() {
    const ok = await copyToClipboard(visibleRows.map((r) => r.email).join("\n"));
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  // --- Render --------------------------------------------------------------
  if (!ready) return <div className="pv-card h-40 animate-pulse" />;
  if (!hasKey) return <ConnectPrompt onConnected={loadWorkspaces} />;

  return (
    <div className="space-y-5">
      <Controls
        workspaces={workspaces}
        workspacesLoading={workspacesLoading}
        scope={scope}
        onScopeChange={handleScopeChange}
        start={start}
        end={end}
        activePreset={activePreset}
        onPreset={handlePreset}
        onStartChange={(v) => {
          setStart(v);
          setActivePreset(null);
          invalidateStats();
        }}
        onEndChange={(v) => {
          setEnd(v);
          setActivePreset(null);
          invalidateStats();
        }}
        rangeProblem={rangeProblem}
        senderProvider={senderProvider}
        onSenderProviderChange={setSenderProvider}
        senderCounts={senderCounts}
        includeChart={includeChart}
        onIncludeChartChange={(v) => {
          setIncludeChart(v);
          invalidateStats();
        }}
        onFind={() => void findInboxes()}
        onLoad={() => void loadStats(inScope)}
        findBusy={findBusy}
        statsBusy={statsBusy}
        inboxesKnown={rows.length}
        toLoad={toLoad}
      />

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          <AlertIcon size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {findBusy && (
        <div className="pv-card flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
          <Spinner size={13} />
          Finding inboxes… {findProgress.done} / {findProgress.total} workspace
          {findProgress.total === 1 ? "" : "s"}
          {findProgress.name && ` · ${findProgress.name}`}
          {rows.length > 0 && ` · ${formatNumber(rows.length)} so far`}
        </div>
      )}

      {statsBusy && progress.total > 0 && (
        <div className="pv-card p-4">
          <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
            <span className="flex items-center gap-2">
              <Spinner size={12} />
              Loading inbox stats…
            </span>
            <span className="tabular-nums">
              {formatNumber(progress.done)} / {formatNumber(progress.total)}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-accent transition-all duration-300"
              style={{ width: `${progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0}%` }}
            />
          </div>
        </div>
      )}

      {rows.length === 0 && !findBusy && (
        <EmptyState icon={<MailIcon />} title="Nothing fetched yet">
          Choose the workspace — or all of them — the date range and the
          provider, then press <strong>Find inboxes</strong>. That lists the
          inboxes with one call per workspace. Their stats are fetched only
          when you press <strong>Load stats</strong>, 100 inboxes per call.
          {foundFor && error ? " The last lookup failed." : ""}
        </EmptyState>
      )}

      {rows.length > 0 && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span data-found>
                {formatNumber(rows.length)} inbox{rows.length === 1 ? "" : "es"} across{" "}
                {foundFor?.label}
                {senderProvider && (
                  <>
                    {" "}· showing {formatNumber(activeRows.length)} sending through{" "}
                    <span className="text-foreground">{providerLabel(senderProvider)}</span>
                  </>
                )}
              </span>
              {isGlobal && workspaceCounts.size > 1 && (
                <select
                  className="pv-input w-auto py-1 text-xs"
                  value={workspaceFilter ?? ""}
                  onChange={(e) => {
                    setWorkspaceFilter(e.target.value || null);
                    setSelectedId(null);
                  }}
                  aria-label="Filter by workspace"
                >
                  <option value="">Every workspace</option>
                  {workspaces
                    .filter((w) => workspaceCounts.has(w._id))
                    .map((w) => (
                      <option key={w._id} value={w._id}>
                        {w.name} ({formatNumber(workspaceCounts.get(w._id) ?? 0)})
                      </option>
                    ))}
                </select>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {hiddenInactive > 0 && (
                <span className="text-xs text-muted-foreground">
                  {formatNumber(hiddenInactive)} inbox{hiddenInactive === 1 ? "" : "es"}{" "}
                  {minSendsNum > 1 ? `under ${formatNumber(minSendsNum)} sends hidden` : "with no sends hidden"}
                </span>
              )}
              <div className="flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs">
                <span className="text-muted-foreground">Min&nbsp;sends</span>
                <input
                  type="number"
                  step="1"
                  min="0"
                  value={minSends}
                  onChange={(e) => setMinSends(e.target.value)}
                  className="w-16 rounded-md border border-input bg-background px-1.5 py-0.5 text-right tabular-nums outline-none focus:border-accent focus:ring-2 focus:ring-accent/25"
                  aria-label="Minimum sends per inbox"
                />
              </div>
            </div>
          </div>

          {nothingLoaded ? (
            <div className="pv-card flex flex-col items-center justify-center px-6 py-10 text-center">
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                <MailIcon />
              </div>
              <h3 className="text-base font-semibold">
                {formatNumber(rows.length)} inbox{rows.length === 1 ? "" : "es"} found
              </h3>
              <p className="mt-1.5 max-w-md text-sm text-muted-foreground">
                Nothing else has been fetched. Narrow it down by provider if you
                want, then load the stats for {senderProvider ? "just those" : "all of them"}{" "}
                — {formatNumber(Math.ceil(toLoad / BULK_CHUNK))} call{Math.ceil(toLoad / BULK_CHUNK) === 1 ? "" : "s"} for{" "}
                {formatNumber(toLoad)} inbox{toLoad === 1 ? "" : "es"}.
              </p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
                <StatCard
                  label="Emails sent"
                  value={formatNumber(summary.sent)}
                  sub={`${formatNumber(summary.count)} active inbox${summary.count === 1 ? "" : "es"}`}
                  loading={summaryLoading}
                />
                <StatCard
                  label="True reply rate"
                  value={formatPercent(summary.replyRate)}
                  sub={`${formatNumber(summary.replies)} replies ÷ ${formatNumber(summary.contacted)} contacted`}
                  health={replyRateHealth(summary.replyRate)}
                  loading={summaryLoading}
                />
                <StatCard
                  label="Reply rate (with OOO)"
                  value={formatPercent(summary.replyRateOoo)}
                  sub={`${formatNumber(summary.replies + summary.ooo)} incl. out-of-office`}
                  health={replyRateHealth(summary.replyRateOoo)}
                  loading={summaryLoading}
                />
                <StatCard
                  label="Positive reply rate"
                  value={formatPercent(summary.posRate)}
                  sub={`${formatNumber(summary.posReplies)} positive`}
                  loading={summaryLoading}
                />
                <StatCard
                  label="Bounce rate"
                  value={formatPercent(summary.bounceRate)}
                  sub={`${formatNumber(summary.bounces)} bounces`}
                  health={bounceRateHealth(summary.bounceRate)}
                  loading={summaryLoading}
                />
              </div>

              {chartsLoaded || statsBusy ? (
                <OverviewChart data={chartData} title={chartTitle} loading={statsBusy && chartData.length === 0} />
              ) : (
                <p className="text-xs text-muted-foreground" data-no-chart>
                  Daily chart not loaded — tick <em>Daily chart</em> and load again to see sends and replies over time.
                </p>
              )}

              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-sm font-semibold">By sending inbox</h2>
                    {loadedRows.length > 0 && thresholdValid && (
                      <span
                        className="pv-chip"
                        title={`${burnedRows.length} of ${loadedRows.length} inboxes have a true reply rate below ${threshold}% and an OOO reply rate below ${BURNED_OOO_SAFE}%`}
                      >
                        <FireIcon size={13} className="text-danger" />
                        {burnedPct.toFixed(1)}% burned · {burnedRows.length}/{loadedRows.length}
                      </span>
                    )}
                    {selectedRow && (
                      <button type="button" onClick={() => setSelectedId(null)} className="pv-chip pv-chip-active">
                        {selectedRow.email} · clear
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setBurnedOnly((v) => !v)}
                      className={`pv-chip ${burnedOnly ? "pv-chip-active" : "hover:text-foreground"}`}
                    >
                      <FireIcon size={13} />
                      {burnedOnly ? "Burned inboxes only" : "Filter burned inboxes"}
                    </button>
                    {burnedOnly && (
                      <div className="flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs">
                        <span className="text-muted-foreground">True&nbsp;reply&nbsp;% below</span>
                        <input
                          type="number"
                          step="0.1"
                          min="0"
                          value={threshold}
                          onChange={(e) => setThreshold(e.target.value)}
                          className="w-14 rounded-md border border-input bg-background px-1.5 py-0.5 text-right tabular-nums outline-none focus:border-accent focus:ring-2 focus:ring-accent/25"
                          aria-label="Burned threshold"
                        />
                      </div>
                    )}
                    <button
                      type="button"
                      className="pv-btn-ghost"
                      disabled={visibleRows.length === 0}
                      onClick={handleCopy}
                      title="Copies the addresses shown, one per line"
                    >
                      {copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
                      <span className="hidden sm:inline">
                        {copied ? "Copied!" : `Copy ${formatNumber(visibleRows.length)} inbox${visibleRows.length === 1 ? "" : "es"}`}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="pv-btn-ghost"
                      disabled={visibleRows.length === 0}
                      onClick={() =>
                        exportInboxesCsv(visibleRows, {
                          scope: (burnedOnly ? "burned-" : "") + (foundFor?.label ?? "inboxes"),
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
                <p className="text-xs text-muted-foreground">
                  Rates are replies ÷ unique leads contacted, worked out here from the counts.
                  Plusvibe&apos;s own per-sent reply rate is not used.
                  {burnedOnly && thresholdValid && (
                    <>
                      {" "}Showing {burnedRows.length} of {loadedRows.length} loaded inbox{loadedRows.length === 1 ? "" : "es"} (
                      {burnedPct.toFixed(1)}%) with true reply rate below {threshold}% and OOO reply rate below {BURNED_OOO_SAFE}%.
                    </>
                  )}
                </p>
              </div>
            </>
          )}

          {visibleRows.length > 0 ? (
            <>
              {!burnedOnly && chartsLoaded && (
                <p className="-mt-2 text-xs text-muted-foreground">Click an inbox to focus the chart on it.</p>
              )}
              <InboxTable
                rows={visibleRows}
                sort={sort}
                onSort={handleSort}
                selected={selectedId}
                onSelect={setSelectedId}
                showWorkspace={isGlobal}
              />
            </>
          ) : (
            !statsBusy &&
            (burnedOnly ? (
              <EmptyState icon={<FireIcon />} title="No burned inboxes">
                No inbox has a true reply rate below {thresholdValid ? threshold : "0"}% in this range.
              </EmptyState>
            ) : (
              <EmptyState title="No inboxes to show">
                {hiddenInactive > 0
                  ? `${formatNumber(hiddenInactive)} inbox${hiddenInactive === 1 ? " is" : "es are"} hidden by the minimum sends.`
                  : "Nothing matches the filters."}
              </EmptyState>
            ))
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
    domain: domainFromEmail(a.email) ?? "",
    workspaceId: ws._id,
    workspaceName: ws.name,
    provider: providerBucket(a.provider),
    accountStatus: a.status,
    warmupStatus: a.warmup_status,
    status: "pending",
  };
}

function patchRows(
  setRows: React.Dispatch<React.SetStateAction<InboxRow[]>>,
  ids: Set<string>,
  patch: Partial<InboxRow>
) {
  setRows((prev) => prev.map((r) => (ids.has(r.id) ? { ...r, ...patch } : r)));
}

function isAbort(err: unknown): boolean {
  return (err instanceof DOMException && err.name === "AbortError") || (err instanceof Error && err.name === "AbortError");
}

function errMessage(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
