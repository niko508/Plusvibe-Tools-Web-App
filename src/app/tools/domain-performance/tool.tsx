"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Workspace, EmailStatsChartPoint } from "@/lib/plusvibe-types";
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
} from "@/lib/format";
import { mapPool } from "@/lib/concurrency";
import { ConnectPrompt } from "@/components/connect-prompt";
import { StatCard } from "@/components/stat-card";
import { EmptyState, Spinner } from "@/components/ui";
import {
  AlertIcon,
  DownloadIcon,
  GaugeIcon,
  CopyIcon,
  CheckIcon,
  FireIcon,
} from "@/components/icons";
import { Controls } from "./controls";
import { OverviewChart } from "./overview-chart";
import { DomainTable, computeTotals } from "./domain-table";
import { exportDomainsCsv } from "./csv";
import type { DomainRow, SortKey, SortState } from "./types";

const LAST_WS_KEY = "pv_last_workspace";
const BURNED_THRESHOLD_KEY = "pv_burned_threshold";
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
  const [busy, setBusy] = useState(false);
  // Client-side sender-ESP filter (instant, no re-fetch). Domains with no
  // campaign sends in the range are always hidden.
  const [senderProvider, setSenderProvider] = useState<string | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null);
  const [sort, setSort] = useState<SortState>({ key: "sent", dir: "desc" });
  const [ranMeta, setRanMeta] = useState<{ workspaceName: string } | null>(null);

  // "Burned domains" filter: show only domains whose reply rate is below a
  // threshold, so they can be copied/exported for pausing or replacing. The
  // threshold persists in localStorage so it's a set-once global default that
  // applies across every workspace.
  const [burnedOnly, setBurnedOnly] = useState(false);
  const [threshold, setThreshold] = useState("0.2");
  const [thresholdLoaded, setThresholdLoaded] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const saved =
      typeof window !== "undefined"
        ? window.localStorage.getItem(BURNED_THRESHOLD_KEY)
        : null;
    if (saved !== null) setThreshold(saved);
    setThresholdLoaded(true);
  }, []);

  useEffect(() => {
    if (thresholdLoaded && typeof window !== "undefined") {
      window.localStorage.setItem(BURNED_THRESHOLD_KEY, threshold);
    }
  }, [threshold, thresholdLoaded]);

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
        // Accounts -> unique sending domains (with their sender ESPs).
        const accountsRes = await fetchAccounts(
          { workspace_id: params.workspaceId },
          signal
        );
        const groups = groupByDomain(accountsRes.accounts ?? []);
        setRows(
          groups.map((g) => ({
            domain: g.domain,
            mailboxes: g.mailboxes,
            providers: g.providers,
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
  // Client-side filters: sender ESP + hide warming/inactive (0 sent). A domain
  // is "warming/inactive" once loaded with 0 sent in the range.
  const activeRows = rows.filter((r) => {
    if (senderProvider && !r.providers.includes(senderProvider)) return false;
    // Always hide domains that sent no campaign emails in the range.
    if (r.status === "done" && r.header && r.header.total_sent_count === 0) {
      return false;
    }
    return true;
  });
  const hiddenInactive = rows.filter(
    (r) =>
      (!senderProvider || r.providers.includes(senderProvider)) &&
      r.status === "done" &&
      r.header &&
      r.header.total_sent_count === 0
  ).length;

  const selectedRow = rows.find((r) => r.domain === selectedDomain);
  const chartData = selectedRow?.chart ?? aggregateChart(activeRows);
  const chartTitle = selectedRow
    ? `${selectedDomain} · ${start} → ${end}`
    : ranMeta
      ? `${senderProvider ? providerLabel(senderProvider) + " domains" : "All domains"} · ${start} → ${end}`
      : "";
  const hasResults = rows.length > 0;

  // Aggregate summary from the filtered, loaded domains so the cards, chart,
  // table and burned% all reflect the same set.
  const loadedRows = activeRows.filter((r) => r.status === "done" && r.header);
  const summary = computeTotals(loadedRows);
  const summaryLoading = busy && loadedRows.length === 0;

  // Burned-domain filtering: loaded domains whose reply rate is below the
  // threshold.
  const thresholdNum = parseFloat(threshold);
  const thresholdValid = Number.isFinite(thresholdNum);
  const burnedRows = thresholdValid
    ? loadedRows.filter((r) => r.header!.reply_rate < thresholdNum)
    : [];
  const burnedPct =
    loadedRows.length > 0 ? (burnedRows.length / loadedRows.length) * 100 : 0;
  const visibleRows = burnedOnly ? burnedRows : activeRows;

  async function handleCopyDomains() {
    const text = visibleRows.map((r) => r.domain).join("\n");
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

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
          {/* Filters */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">Sender ESP:</span>
              {ESP_OPTIONS.map((o) => (
                <button
                  key={o.label}
                  type="button"
                  onClick={() => setSenderProvider(o.key)}
                  className={`pv-chip ${
                    senderProvider === o.key ? "pv-chip-active" : "hover:text-foreground"
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
            {hiddenInactive > 0 && (
              <span className="text-xs text-muted-foreground">
                {formatNumber(hiddenInactive)} domain
                {hiddenInactive === 1 ? "" : "s"} with no sends hidden
              </span>
            )}
          </div>

          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
            <StatCard
              label="Emails sent"
              value={formatNumber(summary.sent)}
              sub={`${formatNumber(summary.count)} active domain${summary.count === 1 ? "" : "s"}`}
              loading={summaryLoading}
            />
            <StatCard
              label="True reply rate"
              value={formatPercent(summary.replyRate)}
              sub={`${formatNumber(summary.replies)} replies · excl. OOO`}
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

          {/* Overview chart */}
          <OverviewChart
            data={chartData}
            title={chartTitle}
            loading={busy && chartData.length === 0}
          />

          {/* Domain table + burned-domain filter */}
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold">By sending domain</h2>
                {loadedRows.length > 0 && thresholdValid && (
                  <span
                    className="pv-chip"
                    title={`${burnedRows.length} of ${loadedRows.length} domains have a true reply rate below ${threshold}%`}
                  >
                    <FireIcon size={13} className="text-danger" />
                    {burnedPct.toFixed(1)}% burned · {burnedRows.length}/
                    {loadedRows.length}
                  </span>
                )}
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

              <div className="flex flex-wrap items-center gap-2">
                {/* Burned-domain toggle */}
                <button
                  type="button"
                  onClick={() => setBurnedOnly((v) => !v)}
                  className={`pv-chip ${
                    burnedOnly ? "pv-chip-active" : "hover:text-foreground"
                  }`}
                >
                  <FireIcon size={13} />
                  {burnedOnly ? "Burned domains only" : "Filter burned domains"}
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
                    />
                  </div>
                )}

                {burnedOnly && (
                  <button
                    type="button"
                    className="pv-btn-ghost"
                    disabled={burnedRows.length === 0}
                    onClick={handleCopyDomains}
                  >
                    {copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
                    <span className="hidden sm:inline">
                      {copied
                        ? "Copied!"
                        : `Copy ${burnedRows.length} domain${
                            burnedRows.length === 1 ? "" : "s"
                          }`}
                    </span>
                  </button>
                )}

                <button
                  type="button"
                  className="pv-btn-ghost"
                  disabled={visibleRows.length === 0}
                  onClick={() =>
                    exportDomainsCsv(visibleRows, {
                      workspace:
                        (burnedOnly ? "burned-" : "") +
                        (ranMeta?.workspaceName ?? "workspace"),
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

            {burnedOnly && (
              <p className="text-xs text-muted-foreground">
                {thresholdValid ? (
                  <>
                    Showing {burnedRows.length} of {loadedRows.length} loaded
                    domain{loadedRows.length === 1 ? "" : "s"} (
                    {burnedPct.toFixed(1)}%) with true reply rate below {threshold}%
                    {busy ? " so far (still loading…)" : ""}. Copy grabs the
                    domain names, one per line.
                  </>
                ) : (
                  <>Enter a valid reply-rate threshold.</>
                )}
              </p>
            )}
          </div>

          {visibleRows.length > 0 ? (
            <>
              {!burnedOnly && (
                <p className="-mt-2 text-xs text-muted-foreground">
                  Click a domain to focus the chart on it.
                </p>
              )}
              <DomainTable
                rows={visibleRows}
                sort={sort}
                onSort={handleSort}
                selected={selectedDomain}
                onSelect={setSelectedDomain}
              />
            </>
          ) : (
            !busy &&
            (burnedOnly ? (
              <EmptyState icon={<FireIcon />} title="No burned domains">
                No domains have a true reply rate below{" "}
                {thresholdValid ? threshold : "0"}% in this range. Raise the
                threshold or widen the date range.
              </EmptyState>
            ) : (
              <EmptyState title="No sending domains found">
                None of this workspace&apos;s mailboxes have a parseable sending
                domain in the selected range.
              </EmptyState>
            ))
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

const ESP_OPTIONS: { key: string | null; label: string }[] = [
  { key: null, label: "All" },
  { key: "GOOGLE_WORKSPACE", label: "Google" },
  { key: "MICROSOFT365", label: "Microsoft" },
  { key: "REGULAR_ACCOUNT", label: "Other / SMTP" },
];

function providerLabel(key: string): string {
  return ESP_OPTIONS.find((o) => o.key === key)?.label ?? key;
}

// Sums the per-day charts of the given domain rows into a single workspace-like
// series (so the overview chart reflects the active filters).
function aggregateChart(rows: DomainRow[]): EmailStatsChartPoint[] {
  const byDate = new Map<string, EmailStatsChartPoint>();
  for (const r of rows) {
    for (const p of r.chart ?? []) {
      const existing = byDate.get(p.date);
      if (!existing) {
        byDate.set(p.date, { ...p });
      } else {
        existing.total_sent_count += p.total_sent_count;
        existing.total_reply_count += p.total_reply_count;
        existing.total_ooo_reply_count += p.total_ooo_reply_count;
        existing.total_open_count += p.total_open_count;
        existing.total_bounce_count += p.total_bounce_count;
        existing.total_contacted_count += p.total_contacted_count;
        existing.total_completed_count += p.total_completed_count;
        existing.total_pos_reply_count += p.total_pos_reply_count;
      }
    }
  }
  return Array.from(byDate.values()).sort((a, b) =>
    a.date.localeCompare(b.date)
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

// Copies text to the clipboard, falling back to a hidden textarea when the
// async Clipboard API is unavailable. Returns whether it succeeded.
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
