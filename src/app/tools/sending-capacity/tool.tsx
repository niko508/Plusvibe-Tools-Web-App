"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiClientError,
  abortCapacityJob,
  deleteCapacityJob,
  listCapacityJobs,
  startCapacityRefresh,
} from "@/lib/api-client";
import type { CapacityJob } from "@/lib/jobs/capacity-types";
import {
  CAPACITY_ORDER,
  COLUMN_LABELS,
  DAILY_PER_INBOX,
  EXCLUDED_WORKSPACES,
  csvNameFor,
  toCsv,
  type WorkspaceCapacity,
} from "@/lib/capacity/capacity";
import { copyToClipboard } from "@/lib/clipboard";
import { formatNumber } from "@/lib/format";
import { useApiKey } from "@/lib/use-api-key";
import { ConnectPrompt } from "@/components/connect-prompt";
import { StatCard } from "@/components/stat-card";
import { EmptyState, Spinner } from "@/components/ui";
import { AlertIcon, CopyIcon, CheckIcon, DownloadIcon, GaugeIcon, RefreshIcon } from "@/components/icons";

// Sending Capacity: how much this account could send in a day, per workspace
// and all told.
//
// Reads only. The numbers are a plan, not a measurement — every inbox counts
// whether or not it is sending today, because capacity is what the
// infrastructure could carry, and that is what the page says.

const POLL_MS = 2000;

export function CapacityTool() {
  const { hasKey, ready } = useApiKey();
  const [jobs, setJobs] = useState<CapacityJob[]>([]);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const lock = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setJobs((await listCapacityJobs()).jobs);
    } catch {
      // a failed poll is not worth a banner
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (ready && hasKey) void refresh();
  }, [ready, hasKey, refresh]);

  // The newest run is the one on screen; older ones are only kept so a refresh
  // that goes wrong has something to fall back to.
  const job = jobs[0] ?? null;
  const running = job?.status === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [running, refresh]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const rows = useMemo(() => job?.rows ?? [], [job]);
  const totals = job?.totals;

  async function handleRefresh() {
    if (lock.current || running) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await startCapacityRefresh();
      await refresh();
    } catch (err) {
      setError(err instanceof ApiClientError || err instanceof Error ? err.message : "Something went wrong.");
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
      setError(err instanceof ApiClientError || err instanceof Error ? err.message : "Something went wrong.");
    }
  };

  function handleDownload() {
    const blob = new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = csvNameFor(new Date());
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  if (!ready) return <div className="pv-card h-40 animate-pulse" />;
  if (!hasKey) return <ConnectPrompt onConnected={refresh} />;

  const pct = job && job.progress.total > 0 ? Math.round((job.progress.done / job.progress.total) * 100) : 0;

  return (
    <div className="space-y-5">
      {/* The Refresh button, and what the numbers rest on */}
      <div className="pv-card space-y-3 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="pv-btn-primary text-base disabled:opacity-50"
            disabled={busy || running}
            onClick={handleRefresh}
            data-refresh
          >
            {busy || running ? <Spinner /> : <RefreshIcon size={16} />}
            Refresh
          </button>
          <span className="text-xs text-muted-foreground">
            {running
              ? `Counting ${formatNumber(job.progress.done)} of ${formatNumber(job.progress.total)} workspaces…`
              : job
                ? `Last counted ${new Date(job.finishedAt ?? job.updatedAt).toLocaleString()}.`
                : "Reads every workspace's inboxes and counts what they run on. Nothing is changed."}
          </span>
          {running && (
            <button type="button" className="pv-btn-ghost text-xs" onClick={() => act(() => abortCapacityJob(job.id))}>
              Stop
            </button>
          )}
        </div>

        {running && (
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-accent transition-all duration-300" style={{ width: `${pct}%` }} />
          </div>
        )}

        <p className="text-xs text-muted-foreground" data-rates>
          A day&apos;s capacity per inbox:{" "}
          {CAPACITY_ORDER.map((c) => (
            <span key={c} className="mr-2 inline-block">
              <span className="font-medium text-foreground">{COLUMN_LABELS[c]}</span> {DAILY_PER_INBOX[c]}
            </span>
          ))}
          · Azure 25 is a domain with 25 mailboxes or fewer, Azure 50 one with more · every inbox counts, sending or not
        </p>
        <p className="text-xs text-muted-foreground" data-excluded>
          Always left out: {EXCLUDED_WORKSPACES.map((w) => `“${w}”`).join(" and ")}
          {job && job.excluded.length > 0 ? ` · ${formatNumber(job.excluded.length)} skipped this run` : ""}
        </p>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          <AlertIcon size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {!loaded ? (
        <div className="pv-card h-40 animate-pulse" />
      ) : !job ? (
        <EmptyState icon={<GaugeIcon />} title="Nothing counted yet">
          Press <strong>Refresh</strong>. It reads every workspace and keeps going if you close this tab.
        </EmptyState>
      ) : (
        <>
          {/* The overview, above everything */}
          {totals && (
            <div className="space-y-3" data-overview>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                {CAPACITY_ORDER.map((c) => (
                  <StatCard
                    key={c}
                    label={COLUMN_LABELS[c]}
                    value={formatNumber(totals.counts[c])}
                    sub={`${DAILY_PER_INBOX[c]} a day each`}
                  />
                ))}
              </div>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                <StatCard label="Google Sending Capacity" value={formatNumber(totals.google)} sub="emails a day" />
                <StatCard label="Microsoft Sending Capacity" value={formatNumber(totals.microsoft)} sub="emails a day" />
                <StatCard
                  label="Total Sending Capacity"
                  value={formatNumber(totals.total)}
                  sub={`across ${formatNumber(totals.workspaces)} workspace${totals.workspaces === 1 ? "" : "s"}`}
                  health="good"
                />
              </div>
              {totals.uncategorized > 0 && (
                <p className="flex gap-1.5 text-xs text-warning" data-uncategorized>
                  <AlertIcon size={13} className="mt-0.5 shrink-0" />
                  <span>
                    {formatNumber(totals.uncategorized)} of {formatNumber(totals.inboxes)} inboxes are on domains that
                    are on neither Google nor Microsoft, so they carry no capacity here.
                  </span>
                </p>
              )}
            </div>
          )}

          {(job.errors ?? []).length > 0 && (
            <div className="space-y-1.5">
              {job.errors.slice(0, 3).map((e, i) => (
                <p key={i} className="flex gap-1.5 text-xs text-warning">
                  <AlertIcon size={13} className="mt-0.5 shrink-0" />
                  <span>{e}</span>
                </p>
              ))}
              {job.errors.length > 3 && (
                <p className="text-xs text-muted-foreground">+{job.errors.length - 3} more</p>
              )}
            </div>
          )}

          {/* Per workspace */}
          <div className="pv-card space-y-3 p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">By workspace</h2>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="pv-btn-ghost text-xs disabled:opacity-50"
                  disabled={rows.length === 0}
                  onClick={async () => {
                    if (await copyToClipboard(toCsv(rows))) setCopied(true);
                  }}
                  data-copy
                >
                  {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
                  {copied ? "Copied!" : "Copy"}
                </button>
                <button
                  type="button"
                  className="pv-btn-ghost text-xs disabled:opacity-50"
                  disabled={rows.length === 0}
                  onClick={handleDownload}
                  data-csv
                >
                  <DownloadIcon size={14} />
                  CSV
                </button>
              </div>
            </div>

            {rows.length === 0 ? (
              <p className="rounded-xl border border-border px-3 py-6 text-center text-sm text-muted-foreground">
                {running ? "Counting…" : "No workspaces were counted."}
              </p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full min-w-[840px] text-sm">
                  <thead className="bg-muted/50 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Plusvibe Workspace</th>
                      {CAPACITY_ORDER.map((c) => (
                        <th key={c} className="px-3 py-2 text-right font-medium">
                          {COLUMN_LABELS[c]}
                        </th>
                      ))}
                      <th className="px-3 py-2 text-right font-medium">Google Sending Capacity</th>
                      <th className="px-3 py-2 text-right font-medium">Microsoft Sending Capacity</th>
                      <th className="px-3 py-2 text-right font-medium">Total Sending Capacity</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {rows.map((r) => (
                      <Row key={r.workspaceId} row={r} />
                    ))}
                  </tbody>
                  {totals && (
                    <tfoot className="border-t-2 border-border bg-muted/30 text-sm font-medium">
                      <tr data-totals-row>
                        <td className="px-3 py-2">All workspaces</td>
                        {CAPACITY_ORDER.map((c) => (
                          <td key={c} className="px-3 py-2 text-right tabular-nums">
                            {formatNumber(totals.counts[c])}
                          </td>
                        ))}
                        <td className="px-3 py-2 text-right tabular-nums">{formatNumber(totals.google)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatNumber(totals.microsoft)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatNumber(totals.total)}</td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            )}

            {!running && (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="pv-btn-ghost text-xs"
                  onClick={() => act(() => deleteCapacityJob(job.id))}
                >
                  Clear this count
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Row({ row }: { row: WorkspaceCapacity }) {
  return (
    <tr className="hover:bg-muted/40" data-workspace={row.workspaceId}>
      <td className="px-3 py-2">
        <div className="truncate font-medium" title={row.workspaceName}>
          {row.workspaceName}
        </div>
        {row.uncategorized > 0 && (
          <div className="text-[11px] text-muted-foreground">
            {formatNumber(row.uncategorized)} on neither provider
          </div>
        )}
      </td>
      {CAPACITY_ORDER.map((c) => (
        <td key={c} className="px-3 py-2 text-right tabular-nums">
          {formatNumber(row.counts[c])}
        </td>
      ))}
      <td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.google)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.microsoft)}</td>
      <td className="px-3 py-2 text-right font-medium tabular-nums">{formatNumber(row.total)}</td>
    </tr>
  );
}
