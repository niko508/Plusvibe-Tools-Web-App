"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Workspace, EmailStatsResponse } from "@/lib/plusvibe-types";
import {
  fetchWorkspaces,
  fetchAccounts,
  fetchEmailStats,
  ApiClientError,
} from "@/lib/api-client";
import { useApiKey } from "@/lib/use-api-key";
import {
  DATE_PRESETS,
  groupByDomain,
  formatNumber,
  formatPercent,
  bounceRateHealth,
  replyRateHealth,
  uniqueContacted,
} from "@/lib/format";
import { mapPool } from "@/lib/concurrency";
import { ConnectPrompt } from "@/components/connect-prompt";
import { StatCard } from "@/components/stat-card";
import { EmptyState, Spinner } from "@/components/ui";
import { AlertIcon, DownloadIcon, GaugeIcon } from "@/components/icons";
import { Controls } from "./controls";
import { OverviewChart } from "./overview-chart";
import { DomainTable } from "./domain-table";
import { exportDomainsCsv } from "./csv";
import type { DomainRow, SortKey, SortState } from "./types";

const LAST_WS_KEY = "pv_last_workspace";
const DEFAULT_PRESET = "30d";

interface RunParams {
  workspaceId: string;
  start: string;
  end: string;
  recpProvider: string | null;
}

export function DomainPerformanceTool() {
  const { hasKey, ready } = useApiKey();

  // Workspaces
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(false);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);

  // Date range + filters
  const initialRange = DATE_PRESETS.find((p) => p.key === DEFAULT_PRESET)!.range();
  const [start, setStart] = useState(initialRange.start);
  const [end, setEnd] = useState(initialRange.end);
  const [activePreset, setActivePreset] = useState<string | null>(DEFAULT_PRESET);
  const [recpProvider, setRecpProvider] = useState<string | null>(null);

  // Results
  const [rows, setRows] = useState<DomainRow[]>([]);
  const [wsStats, setWsStats] = useState<EmailStatsResponse | null>(null);
  const [wsLoading, setWsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null);
  const [sort, setSort] = useState<SortState>({ key: "sent", dir: "desc" });
  const [ranMeta, setRanMeta] = useState<{ workspaceName: string } | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // --- Load workspaces when a key becomes available ------------------------
  const loadWorkspaces = useCallback(async () => {
    setWorkspacesLoading(true);
    setError(null);
    try {
      const res = await fetchWorkspaces();
      const list = res.workspaces ?? [];
      setWorkspaces(list);
      if (list.length) {
        const stored =
          typeof window !== "undefined"
            ? window.localStorage.getItem(LAST_WS_KEY)
            : null;
        const initial =
          list.find((w) => w._id === stored)?._id ?? list[0]._id;
        setWorkspaceId(initial);
        void run({ workspaceId: initial, start, end, recpProvider }, list);
      } else {
        setWorkspaceId(null);
      }
    } catch (err) {
      setError(errMessage(err));
      setWorkspaces([]);
    } finally {
      setWorkspacesLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, end, recpProvider]);

  useEffect(() => {
    if (ready && hasKey) {
      void loadWorkspaces();
    } else if (ready && !hasKey) {
      setWorkspaces([]);
      setWorkspaceId(null);
      setRows([]);
      setWsStats(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, hasKey]);

  // --- The core run: derive domains, fetch per-domain stats ----------------
  const run = useCallback(
    async (params: RunParams, wsList?: Workspace[]) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const { signal } = controller;

      setBusy(true);
      setError(null);
      setSelectedDomain(null);
      setWsStats(null);
      setRows([]);
      setProgress({ done: 0, total: 0 });

      const list = wsList ?? workspaces;
      const workspaceName =
        list.find((w) => w._id === params.workspaceId)?.name ?? "workspace";
      setRanMeta({ workspaceName });

      if (typeof window !== "undefined") {
        window.localStorage.setItem(LAST_WS_KEY, params.workspaceId);
      }

      const statsBase = {
        workspace_id: params.workspaceId,
        start_date: params.start,
        end_date: params.end,
        recp_provider: params.recpProvider ?? undefined,
      };

      try {
        // 1) Workspace-level totals (fast, drives the summary + default chart).
        setWsLoading(true);
        const wsPromise = fetchEmailStats(statsBase, signal)
          .then((res) => {
            if (!signal.aborted) setWsStats(res);
          })
          .catch((err) => {
            if (!signal.aborted && !isAbort(err)) setError(errMessage(err));
          })
          .finally(() => {
            if (!signal.aborted) setWsLoading(false);
          });

        // 2) Accounts -> unique sending domains.
        const accountsRes = await fetchAccounts(
          { workspace_id: params.workspaceId },
          signal
        );
        const groups = groupByDomain(accountsRes.accounts ?? []);
        setRows(
          groups.map((g) => ({
            domain: g.domain,
            mailboxes: g.mailboxes,
            status: "pending" as const,
          }))
        );
        setProgress({ done: 0, total: groups.length });

        // 3) Per-domain stats, throttled under the rate limit.
        await mapPool(
          groups,
          async (group) => {
            updateRow(setRows, group.domain, { status: "loading" });
            try {
              const res = await fetchEmailStats(
                { ...statsBase, domain: group.domain },
                signal
              );
              updateRow(setRows, group.domain, {
                status: "done",
                header: res.header,
                chart: res.chart,
              });
            } catch (err) {
              if (isAbort(err)) throw err;
              updateRow(setRows, group.domain, {
                status: "error",
                error: errMessage(err),
              });
            } finally {
              if (!signal.aborted) {
                setProgress((p) => ({ ...p, done: p.done + 1 }));
              }
            }
          },
          { concurrency: 4, minSpacingMs: 220, signal }
        );

        await wsPromise;
      } catch (err) {
        if (!isAbort(err)) setError(errMessage(err));
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    },
    [workspaces]
  );

  // --- Handlers ------------------------------------------------------------
  function handleWorkspaceChange(id: string) {
    setWorkspaceId(id);
    void run({ workspaceId: id, start, end, recpProvider });
  }

  function handlePreset(key: string) {
    const preset = DATE_PRESETS.find((p) => p.key === key);
    if (!preset) return;
    const range = preset.range();
    setStart(range.start);
    setEnd(range.end);
    setActivePreset(key);
    if (workspaceId) {
      void run({ workspaceId, start: range.start, end: range.end, recpProvider });
    }
  }

  function handleRecpProvider(value: string | null) {
    setRecpProvider(value);
    if (workspaceId) {
      void run({ workspaceId, start, end, recpProvider: value });
    }
  }

  function handleRefresh() {
    if (workspaceId) void run({ workspaceId, start, end, recpProvider });
  }

  function handleSort(key: SortKey) {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "domain" ? "asc" : "desc" }
    );
  }

  // --- Derived -------------------------------------------------------------
  const header = wsStats?.header;
  const selectedRow = rows.find((r) => r.domain === selectedDomain);
  const chartData = selectedRow?.chart ?? wsStats?.chart ?? [];
  const chartTitle = selectedRow
    ? `${selectedDomain} · ${start} → ${end}`
    : ranMeta
      ? `All domains · ${start} → ${end}`
      : "";
  const hasResults = rows.length > 0 || !!wsStats;

  // --- Render --------------------------------------------------------------
  if (!ready) {
    return <div className="pv-card h-40 animate-pulse" />;
  }

  if (!hasKey) {
    return <ConnectPrompt onConnected={loadWorkspaces} />;
  }

  return (
    <div className="space-y-5">
      <Controls
        workspaces={workspaces}
        workspacesLoading={workspacesLoading}
        workspaceId={workspaceId}
        onWorkspaceChange={handleWorkspaceChange}
        start={start}
        end={end}
        activePreset={activePreset}
        onPreset={handlePreset}
        onStartChange={(v) => {
          setStart(v);
          setActivePreset(null);
        }}
        onEndChange={(v) => {
          setEnd(v);
          setActivePreset(null);
        }}
        recpProvider={recpProvider}
        onRecpProviderChange={handleRecpProvider}
        onRefresh={handleRefresh}
        busy={busy}
      />

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          <AlertIcon size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {busy && progress.total > 0 && (
        <ProgressBar done={progress.done} total={progress.total} />
      )}

      {!hasResults && !busy && !error && (
        <EmptyState icon={<GaugeIcon />} title="No data yet">
          Pick a workspace and date range, then hit Refresh to load domain
          performance.
        </EmptyState>
      )}

      {hasResults && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard
              label="Emails sent"
              value={formatNumber(header?.total_sent_count)}
              sub={header ? `${formatNumber(header.total_completed_count)} sequences completed` : undefined}
              loading={wsLoading && !header}
            />
            <StatCard
              label="Reply rate"
              value={formatPercent(header?.reply_rate)}
              sub={header ? `${formatNumber(header.total_reply_count)} replies` : undefined}
              health={header ? replyRateHealth(header.reply_rate) : "neutral"}
              loading={wsLoading && !header}
            />
            <StatCard
              label="Positive reply rate"
              value={formatPercent(header?.pos_reply_rate)}
              sub={header ? `${formatNumber(header.total_pos_reply_count)} positive` : undefined}
              loading={wsLoading && !header}
            />
            <StatCard
              label="Bounce rate"
              value={formatPercent(header?.bounce_rate)}
              sub={header ? `${formatNumber(header.total_bounce_count)} bounces` : undefined}
              health={header ? bounceRateHealth(header.bounce_rate) : "neutral"}
              loading={wsLoading && !header}
            />
          </div>

          {/* Overview chart */}
          <OverviewChart
            data={chartData}
            title={chartTitle}
            loading={wsLoading && chartData.length === 0}
          />

          {/* Domain table */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">By sending domain</h2>
              {selectedDomain && (
                <button
                  type="button"
                  onClick={() => setSelectedDomain(null)}
                  className="pv-chip pv-chip-active"
                >
                  {selectedDomain} · clear
                </button>
              )}
            </div>
            <button
              type="button"
              className="pv-btn-ghost"
              disabled={rows.length === 0}
              onClick={() =>
                exportDomainsCsv(rows, {
                  workspace: ranMeta?.workspaceName ?? "workspace",
                  start,
                  end,
                })
              }
            >
              <DownloadIcon size={16} />
              <span className="hidden sm:inline">Export CSV</span>
            </button>
          </div>

          {rows.length > 0 ? (
            <>
              <p className="-mt-2 text-xs text-muted-foreground">
                Click a domain to focus the chart on it.
              </p>
              <DomainTable
                rows={rows}
                sort={sort}
                onSort={handleSort}
                selected={selectedDomain}
                onSelect={setSelectedDomain}
              />
            </>
          ) : (
            !busy && (
              <EmptyState title="No sending domains found">
                None of this workspace&apos;s mailboxes have a parseable sending
                domain in the selected range.
              </EmptyState>
            )
          )}
        </>
      )}
    </div>
  );
}

// --- Helpers ---------------------------------------------------------------

function ProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="pv-card p-4">
      <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
        <span className="flex items-center gap-2">
          <Spinner size={12} />
          Loading domain stats…
        </span>
        <span className="tabular-nums">
          {done} / {total}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-accent transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function updateRow(
  setRows: React.Dispatch<React.SetStateAction<DomainRow[]>>,
  domain: string,
  patch: Partial<DomainRow>
) {
  setRows((prev) =>
    prev.map((r) => (r.domain === domain ? { ...r, ...patch } : r))
  );
}

function isAbort(err: unknown): boolean {
  return (
    err instanceof DOMException && err.name === "AbortError"
  ) ||
    (err instanceof Error && err.name === "AbortError");
}

function errMessage(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
