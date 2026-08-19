"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Workspace, CampaignSummary } from "@/lib/plusvibe-types";
import type { MoveLeadsJob, MoveJobStatus } from "@/lib/jobs/move-leads-types";
import { MAX_PAIRS } from "@/lib/jobs/move-leads-types";
import {
  fetchWorkspaces,
  fetchCampaigns,
  fetchLeadsPreview,
  startMoveLeads,
  listMoveLeadsJobs,
  abortMoveLeads,
  ApiClientError,
} from "@/lib/api-client";
import { useApiKey } from "@/lib/use-api-key";
import { formatNumber } from "@/lib/format";
import { ConnectPrompt } from "@/components/connect-prompt";
import { Spinner, EmptyState } from "@/components/ui";
import {
  MoveIcon,
  AlertIcon,
  RefreshIcon,
  ChevronDownIcon,
  CheckIcon,
  TrashIcon,
} from "@/components/icons";

type Bucket = "active" | "draft" | "paused" | "completed" | "archived";

function statusBucket(status: string): Bucket {
  const s = (status ?? "").toUpperCase();
  if (s === "ACTIVE" || s === "RUNNING") return "active";
  if (s === "PAUSED") return "paused";
  if (s === "COMPLETED") return "completed";
  if (s === "ARCHIVED") return "archived";
  return "draft";
}

const BUCKET_LABEL: Record<Bucket, string> = {
  active: "Active",
  draft: "Draft",
  paused: "Paused",
  completed: "Completed",
  archived: "Archived",
};

interface PairRow {
  key: number;
  source: string;
  destination: string;
  count: string;
}

let nextKey = 1;
const emptyRow = (): PairRow => ({
  key: nextKey++,
  source: "",
  destination: "",
  count: "",
});

export function MoveLeadsTool() {
  const { hasKey, ready } = useApiKey();

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(false);
  const [workspaceId, setWorkspaceId] = useState("");

  const [campaigns, setCampaigns] = useState<CampaignSummary[] | null>(null);
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const [rows, setRows] = useState<PairRow[]>([emptyRow()]);
  // campaign id -> not-contacted leads available (undefined = still loading)
  const [available, setAvailable] = useState<Record<string, number | undefined>>(
    {}
  );

  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [jobs, setJobs] = useState<MoveLeadsJob[]>([]);
  const [highlight, setHighlight] = useState<string[]>([]);
  const startLock = useRef(false);

  // --- Workspaces ----------------------------------------------------------
  const loadWorkspaces = useCallback(async () => {
    setWorkspacesLoading(true);
    setError(null);
    try {
      const res = await fetchWorkspaces();
      const list = res.workspaces ?? [];
      setWorkspaces(list);
      setWorkspaceId((prev) => prev || list[0]?._id || "");
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setWorkspacesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (ready && hasKey) void loadWorkspaces();
  }, [ready, hasKey, loadWorkspaces]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  // --- Jobs polling --------------------------------------------------------
  const refreshJobs = useCallback(async () => {
    try {
      const res = await listMoveLeadsJobs();
      setJobs(res.jobs ?? []);
    } catch {
      // transient — keep the last known list
    }
  }, []);

  useEffect(() => {
    if (!(ready && hasKey)) return;
    void refreshJobs();
    const t = setInterval(() => void refreshJobs(), 2500);
    return () => clearInterval(t);
  }, [ready, hasKey, refreshJobs]);

  // --- Campaigns -----------------------------------------------------------
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    const controller = new AbortController();
    setCampaignsLoading(true);
    setCampaigns(null);
    setRows([emptyRow()]);
    setAvailable({});
    setError(null);
    fetchCampaigns({ workspace_id: workspaceId }, controller.signal)
      .then((res) => {
        if (!cancelled) setCampaigns(res.campaigns ?? []);
      })
      .catch((err) => {
        if (!cancelled && !isAbort(err)) setError(errMessage(err));
      })
      .finally(() => {
        if (!cancelled) setCampaignsLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [workspaceId]);

  const allCampaigns = useMemo(
    () => (campaigns ?? []).filter((c) => c.campaignType !== "subseq"),
    [campaigns]
  );

  const visibleCampaigns = useMemo(() => {
    if (showAll) return allCampaigns;
    return allCampaigns.filter((c) => {
      const b = statusBucket(c.status);
      return b === "active" || b === "draft";
    });
  }, [allCampaigns, showAll]);

  // Look up the not-contacted count whenever a source is picked.
  useEffect(() => {
    if (!workspaceId) return;
    const wanted = rows.map((r) => r.source).filter(Boolean);
    for (const id of wanted) {
      if (id in available) continue;
      setAvailable((prev) => ({ ...prev, [id]: undefined }));
      fetchLeadsPreview({ workspace_id: workspaceId, campaign_id: id })
        .then((p) => setAvailable((prev) => ({ ...prev, [id]: p.available })))
        .catch(() =>
          setAvailable((prev) => ({ ...prev, [id]: undefined }))
        );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, workspaceId]);

  async function handleRefresh() {
    if (!workspaceId || refreshing) return;
    setRefreshing(true);
    setError(null);
    try {
      const res = await fetchCampaigns({ workspace_id: workspaceId });
      setCampaigns(res.campaigns ?? []);
      setAvailable({});
      await refreshJobs();
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setRefreshing(false);
    }
  }

  function updateRow(key: number, patch: Partial<PairRow>) {
    setRows((prev) =>
      prev.map((r) => (r.key === key ? { ...r, ...patch } : r))
    );
  }

  // --- Validation ----------------------------------------------------------
  const runningCount = jobs.filter((j) => j.status === "running").length;
  const filledRows = rows.filter(
    (r) => r.source && r.destination && Number(r.count) >= 1
  );
  const duplicateSource =
    new Set(filledRows.map((r) => r.source)).size !== filledRows.length;
  const sameEnds = filledRows.some((r) => r.source === r.destination);
  const overCapacity = runningCount + filledRows.length > MAX_PAIRS;

  const canStart =
    filledRows.length > 0 &&
    !duplicateSource &&
    !sameEnds &&
    !overCapacity &&
    !starting;

  async function handleStart() {
    if (!canStart) return;
    if (startLock.current) return;
    startLock.current = true;
    setStarting(true);
    setError(null);
    try {
      const wsName = workspaces.find((w) => w._id === workspaceId)?.name ?? "";
      const nameOf = (id: string) =>
        allCampaigns.find((c) => c.id === id)?.name ?? "";
      const res = await startMoveLeads({
        workspaceId,
        workspaceName: wsName,
        pairs: filledRows.map((r) => ({
          sourceCampaignId: r.source,
          sourceName: nameOf(r.source),
          destinationCampaignId: r.destination,
          destinationName: nameOf(r.destination),
          count: Number(r.count),
        })),
      });
      setHighlight(res.jobIds ?? []);
      setTimeout(() => setHighlight([]), 4000);
      setRows([emptyRow()]);
      setToast(
        `${res.jobIds.length} move job${res.jobIds.length === 1 ? "" : "s"} started — safe to close the tab`
      );
      await refreshJobs();
    } catch (err) {
      setError(errMessage(err));
    } finally {
      startLock.current = false;
      setStarting(false);
    }
  }

  async function handleAbort(id: string) {
    try {
      await abortMoveLeads(id);
      await refreshJobs();
    } catch {
      // ignore
    }
  }

  // --- Render --------------------------------------------------------------
  if (!ready) return <div className="pv-card h-40 animate-pulse" />;
  if (!hasKey) return <ConnectPrompt onConnected={loadWorkspaces} />;

  return (
    <div className="space-y-5">
      {/* Workspace */}
      <div className="pv-card space-y-4 p-4 sm:p-5">
        <div className="max-w-sm">
          <label className="mb-1.5 block text-sm font-medium">Workspace</label>
          <Select
            value={workspaceId}
            disabled={workspacesLoading || workspaces.length === 0}
            onChange={setWorkspaceId}
          >
            {workspacesLoading && <option>Loading…</option>}
            {!workspacesLoading &&
              workspaces.map((w) => (
                <option key={w._id} value={w._id}>
                  {w.name}
                </option>
              ))}
          </Select>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-accent"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
            />
            Show all campaigns
            {allCampaigns.length > 0 && (
              <span>· {formatNumber(allCampaigns.length)} in this workspace</span>
            )}
          </label>
          <button
            type="button"
            className="pv-btn-ghost text-xs"
            onClick={handleRefresh}
            disabled={!workspaceId || refreshing || campaignsLoading}
          >
            {refreshing ? <Spinner size={14} /> : <RefreshIcon size={14} />}
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          <AlertIcon size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Pairs */}
      <div className="pv-card space-y-4 p-4 sm:p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">
            Moves to run{" "}
            <span className="font-normal text-muted-foreground">
              · up to {MAX_PAIRS} at once
            </span>
          </h2>
          {campaignsLoading && <Spinner size={12} />}
        </div>

        <div className="space-y-3">
          {rows.map((row, i) => {
            const avail = row.source ? available[row.source] : undefined;
            const asked = Number(row.count);
            const tooMany =
              avail !== undefined && Number.isFinite(asked) && asked > avail;
            return (
              <div
                key={row.key}
                className="grid gap-2 rounded-xl border border-border p-3 sm:grid-cols-[1fr_1fr_120px_auto] sm:items-end"
              >
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">
                    Source campaign
                  </label>
                  <Select
                    value={row.source}
                    disabled={campaignsLoading}
                    onChange={(v) => updateRow(row.key, { source: v })}
                  >
                    <option value="">Select…</option>
                    {visibleCampaigns.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} — {BUCKET_LABEL[statusBucket(c.status)]}
                      </option>
                    ))}
                  </Select>
                  <div className="mt-1 h-4 text-[11px] text-muted-foreground">
                    {row.source &&
                      (avail === undefined ? (
                        <span>checking available leads…</span>
                      ) : (
                        <span>
                          {formatNumber(avail)} not-contacted available
                        </span>
                      ))}
                  </div>
                </div>

                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">
                    Destination campaign
                  </label>
                  <Select
                    value={row.destination}
                    disabled={campaignsLoading}
                    onChange={(v) => updateRow(row.key, { destination: v })}
                  >
                    <option value="">Select…</option>
                    {visibleCampaigns.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} — {BUCKET_LABEL[statusBucket(c.status)]}
                      </option>
                    ))}
                  </Select>
                  <div className="mt-1 h-4 text-[11px] text-danger">
                    {row.source && row.source === row.destination
                      ? "Must differ from the source"
                      : ""}
                  </div>
                </div>

                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">
                    Leads
                  </label>
                  <input
                    type="number"
                    min={1}
                    className="pv-input w-full tabular-nums"
                    placeholder="0"
                    value={row.count}
                    onChange={(e) => updateRow(row.key, { count: e.target.value })}
                  />
                  <div className="mt-1 h-4 text-[11px] text-warning">
                    {tooMany ? `only ${formatNumber(avail)} available` : ""}
                  </div>
                </div>

                <div className="pb-5">
                  <button
                    type="button"
                    className="pv-btn-ghost"
                    onClick={() =>
                      setRows((prev) =>
                        prev.length === 1
                          ? [emptyRow()]
                          : prev.filter((r) => r.key !== row.key)
                      )
                    }
                    title={rows.length === 1 ? "Clear this row" : "Remove this pair"}
                    aria-label="Remove pair"
                  >
                    <TrashIcon size={14} />
                  </button>
                </div>
                {i === 0 && null}
              </div>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="pv-btn-ghost text-xs"
            disabled={rows.length >= MAX_PAIRS}
            onClick={() => setRows((prev) => [...prev, emptyRow()])}
          >
            + Add another pair
          </button>
          {duplicateSource && (
            <span className="text-xs text-danger">
              Each source campaign can only be used once.
            </span>
          )}
          {overCapacity && (
            <span className="text-xs text-warning">
              {runningCount} job{runningCount === 1 ? "" : "s"} already running —
              at most {MAX_PAIRS} run at once.
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
          <button
            type="button"
            className="pv-btn-primary"
            disabled={!canStart}
            onClick={handleStart}
          >
            {starting ? <Spinner /> : <MoveIcon size={16} />}
            Start {filledRows.length > 0 ? filledRows.length : ""} move
            {filledRows.length === 1 ? "" : "s"}
          </button>
          <span className="text-xs text-muted-foreground">
            Runs on the server — safe to close the tab. Leads are added to the
            destination before being removed from the source.
          </span>
        </div>
      </div>

      {/* Jobs */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold">Jobs</h2>
        {jobs.length === 0 ? (
          <EmptyState icon={<MoveIcon />} title="No jobs yet">
            Pick a source and destination, set how many leads to move, and start
            — progress appears here and keeps running if you close the app.
          </EmptyState>
        ) : (
          jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              highlight={highlight.includes(job.id)}
              onAbort={handleAbort}
            />
          ))
        )}
      </div>

      {toast && (
        <div className="fixed bottom-5 right-5 z-50 animate-fade-in">
          <div className="flex items-center gap-3 rounded-xl border border-success/40 bg-success/15 px-4 py-3 shadow-card backdrop-blur">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-success/20 text-success">
              <CheckIcon size={14} />
            </span>
            <span className="text-sm font-medium text-success">{toast}</span>
            <button
              type="button"
              onClick={() => setToast(null)}
              className="ml-1 text-success/70 transition hover:text-success"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

const STATUS_META: Record<MoveJobStatus, { label: string; className: string }> = {
  running: { label: "Running", className: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400" },
  done: { label: "Done", className: "bg-success/10 text-success" },
  aborted: { label: "Aborted", className: "bg-muted text-muted-foreground" },
  interrupted: { label: "Interrupted", className: "bg-warning/10 text-warning" },
  error: { label: "Error", className: "bg-danger/10 text-danger" },
};

function JobCard({
  job,
  highlight,
  onAbort,
}: {
  job: MoveLeadsJob;
  highlight: boolean;
  onAbort: (id: string) => void;
}) {
  const p = job.progress;
  const total = p.found || p.requested;
  const pct =
    job.status === "done"
      ? 100
      : total > 0
        ? Math.min(100, Math.round((p.processed / total) * 100))
        : 0;
  const status = STATUS_META[job.status];
  const phaseLabel =
    job.status !== "running"
      ? status.label
      : job.phase === "collecting"
        ? "Collecting not-contacted leads"
        : "Moving leads";

  return (
    <div
      className={`pv-card p-4 sm:p-5 ${highlight ? "ring-2 ring-cyan-500/40" : ""}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-medium ${status.className}`}
          >
            {job.status === "running" && <Spinner size={10} />} {status.label}
          </span>
          <span className="text-sm font-medium">{job.label}</span>
        </div>
        <span className="text-xs text-muted-foreground">
          {relativeTime(job.createdAt)}
        </span>
      </div>

      <div className="mt-3">
        <div className="mb-1.5 flex items-center justify-between text-xs text-muted-foreground">
          <span className="flex items-center gap-2">
            {job.status === "running" && <Spinner size={12} />}
            {phaseLabel}
          </span>
          <span className="tabular-nums">
            {formatNumber(p.processed)} / {formatNumber(total)} · {pct}%
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full rounded-full transition-all duration-300 ${
              job.status === "error" ? "bg-danger" : "bg-cyan-500"
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label="Found" value={p.found} />
        <Metric label="Added to destination" value={p.added} tone="success" />
        <Metric label="Removed from source" value={p.deletedFromSource} tone="success" />
        <Metric
          label="Already in destination"
          value={p.alreadyInDestination}
          tone="muted"
        />
      </div>

      {job.errors.length > 0 && (
        <div className="pv-scroll mt-3 max-h-32 overflow-y-auto rounded-xl border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
          {job.errors.map((e, i) => (
            <div key={i} className="border-b border-danger/20 py-1 last:border-0">
              {e}
            </div>
          ))}
        </div>
      )}

      {job.status === "interrupted" && (
        <p className="mt-2 text-xs text-warning">
          Interrupted by a server restart. Leads already moved are in the
          destination — start another job for the remainder.
        </p>
      )}

      {job.status === "running" && (
        <div className="mt-4">
          <button
            type="button"
            className="pv-btn-ghost"
            onClick={() => onAbort(job.id)}
          >
            Stop task
          </button>
        </div>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "success" | "muted";
}) {
  const color =
    tone === "success"
      ? "text-success"
      : tone === "muted"
        ? "text-muted-foreground"
        : "text-foreground";
  return (
    <div>
      <div className={`text-lg font-semibold tabular-nums ${color}`}>
        {formatNumber(value)}
      </div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function Select({
  value,
  onChange,
  disabled,
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="relative">
      <select
        className="pv-input appearance-none pr-9"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
      <ChevronDownIcon
        size={16}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  );
}

function relativeTime(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(ts).toLocaleDateString();
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
