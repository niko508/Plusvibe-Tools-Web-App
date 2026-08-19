"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Workspace } from "@/lib/plusvibe-types";
import type {
  AzureWarmupJob,
  AzureJobStatus,
} from "@/lib/jobs/azure-warmup-types";
import {
  DEFAULT_SHEET_TAB,
  DEFAULT_SHEET_URL,
  MAX_DELAY_HOURS,
} from "@/lib/jobs/azure-warmup-types";
import {
  fetchWorkspaces,
  startAzureWarmup,
  listAzureWarmupJobs,
  abortAzureWarmup,
  resumeAzureWarmup,
  ApiClientError,
} from "@/lib/api-client";
import { useApiKey } from "@/lib/use-api-key";
import { formatNumber } from "@/lib/format";
import { ConnectPrompt } from "@/components/connect-prompt";
import { StatCard } from "@/components/stat-card";
import { Spinner, EmptyState } from "@/components/ui";
import {
  FireIcon,
  AlertIcon,
  ChevronDownIcon,
  CheckIcon,
  ClockIcon,
  SheetIcon,
  DownloadIcon,
} from "@/components/icons";
import { parseUpload, type ParsedUpload } from "./parse";

export function AzureWarmupTool() {
  const { hasKey, ready } = useApiKey();

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(false);
  const [workspaceId, setWorkspaceId] = useState("");

  const [fileName, setFileName] = useState("");
  const [raw, setRaw] = useState("");
  const [delayHours, setDelayHours] = useState("0");
  const [sheetUrl, setSheetUrl] = useState(DEFAULT_SHEET_URL);
  const [sheetTab, setSheetTab] = useState(DEFAULT_SHEET_TAB);

  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [jobs, setJobs] = useState<AzureWarmupJob[]>([]);
  const [sheetWriting, setSheetWriting] = useState<{
    configured: boolean;
    serviceAccount: string | null;
  } | null>(null);
  const startLock = useRef(false);

  const parsed: ParsedUpload = useMemo(() => parseUpload(raw), [raw]);

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
      const res = await listAzureWarmupJobs();
      setJobs(res.jobs ?? []);
      setSheetWriting(res.sheetWriting ?? null);
    } catch {
      // transient
    }
  }, []);

  useEffect(() => {
    if (!(ready && hasKey)) return;
    void refreshJobs();
    const t = setInterval(() => void refreshJobs(), 5000);
    return () => clearInterval(t);
  }, [ready, hasKey, refreshJobs]);

  async function handleFile(file: File | null) {
    if (!file) return;
    setFileName(file.name);
    setError(null);
    try {
      setRaw(await file.text());
    } catch {
      setError("Could not read that file.");
    }
  }

  const delayNum = Number(delayHours);
  const delayValid =
    Number.isFinite(delayNum) && delayNum >= 0 && delayNum <= MAX_DELAY_HOURS;
  const canStart =
    !!workspaceId && parsed.rows.length > 0 && delayValid && !starting;

  async function handleStart() {
    if (!canStart || startLock.current) return;
    startLock.current = true;
    setStarting(true);
    setError(null);
    try {
      const wsName = workspaces.find((w) => w._id === workspaceId)?.name ?? "";
      await startAzureWarmup({
        workspaceId,
        workspaceName: wsName,
        delayHours: delayNum,
        sheetUrl,
        sheetTab,
        rows: parsed.rows,
      });
      setRaw("");
      setFileName("");
      setToast(
        delayNum > 0
          ? `Job scheduled — starts in ${delayNum} hour${delayNum === 1 ? "" : "s"}`
          : "Job started — safe to close the tab"
      );
      await refreshJobs();
    } catch (err) {
      setError(errMessage(err));
    } finally {
      startLock.current = false;
      setStarting(false);
    }
  }

  if (!ready) return <div className="pv-card h-40 animate-pulse" />;
  if (!hasKey) return <ConnectPrompt onConnected={loadWorkspaces} />;

  return (
    <div className="space-y-5">
      {sheetWriting && !sheetWriting.configured && (
        <div className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
          <AlertIcon size={16} className="mt-0.5 shrink-0" />
          <span>
            Google Sheet writing isn&apos;t configured, so the Domains tab
            won&apos;t be updated — the Plusvibe warmup half still runs. Set{" "}
            <span className="font-mono text-xs">GOOGLE_SERVICE_ACCOUNT_JSON</span>{" "}
            on the service and share the sheet with that service account as an
            Editor.
          </span>
        </div>
      )}

      {/* Setup */}
      <div className="pv-card space-y-4 p-4 sm:p-5">
        <div className="grid gap-4 sm:grid-cols-[1fr_160px]">
          <div>
            <label className="mb-1.5 block text-sm font-medium">Workspace</label>
            <div className="relative">
              <select
                className="pv-input appearance-none pr-9"
                value={workspaceId}
                disabled={workspacesLoading || workspaces.length === 0}
                onChange={(e) => setWorkspaceId(e.target.value)}
              >
                {workspacesLoading && <option>Loading…</option>}
                {!workspacesLoading &&
                  workspaces.map((w) => (
                    <option key={w._id} value={w._id}>
                      {w.name}
                    </option>
                  ))}
              </select>
              <ChevronDownIcon
                size={16}
                className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium">
              Start after
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={MAX_DELAY_HOURS}
                className="pv-input w-full tabular-nums"
                value={delayHours}
                onChange={(e) => setDelayHours(e.target.value)}
              />
              <span className="text-sm text-muted-foreground">h</span>
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">
              {delayNum === 0 ? "starts right away" : `waits ${delayNum}h first`}
            </div>
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium">
            Mailbox CSV
          </label>
          <input
            type="file"
            accept=".csv,text/csv"
            className="pv-input file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1 file:text-sm"
            onChange={(e) => void handleFile(e.target.files?.[0] ?? null)}
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            Needs <span className="font-mono">Email</span>,{" "}
            <span className="font-mono">Domain</span> and{" "}
            <span className="font-mono">Order Email</span> columns — found by
            name, so column order doesn&apos;t matter. The Password column is
            never read.
          </p>
        </div>

        <details className="rounded-xl border border-border px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
            Domains sheet target
          </summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_200px]">
            <div>
              <label className="mb-1 block text-[11px] text-muted-foreground">
                Sheet URL
              </label>
              <input
                className="pv-input text-xs"
                value={sheetUrl}
                onChange={(e) => setSheetUrl(e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px] text-muted-foreground">
                Tab
              </label>
              <input
                className="pv-input text-xs"
                value={sheetTab}
                onChange={(e) => setSheetTab(e.target.value)}
              />
            </div>
          </div>
        </details>

        {parsed.warnings.map((w, i) => (
          <div
            key={i}
            className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning"
          >
            <AlertIcon size={14} className="mt-0.5 shrink-0" />
            <span>{w}</span>
          </div>
        ))}

        {parsed.rows.length > 0 && (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <StatCard label="Domains" value={formatNumber(parsed.domains.length)} />
              <StatCard label="Inboxes" value={formatNumber(parsed.rows.length)} />
              <StatCard
                label="Per domain"
                value={
                  parsed.domains.length > 0
                    ? `${Math.min(...parsed.domains.map((d) => d.inboxes))}–${Math.max(
                        ...parsed.domains.map((d) => d.inboxes)
                      )}`
                    : "—"
                }
              />
              <StatCard label="File" value={fileName || "—"} />
            </div>

            <details className="rounded-xl border border-border px-3 py-2">
              <summary className="cursor-pointer text-xs font-medium">
                Domain → Tenant Email Address mapping (
                {formatNumber(parsed.domains.length)})
              </summary>
              <div className="pv-scroll mt-2 max-h-56 overflow-y-auto">
                <table className="w-full text-xs">
                  <tbody>
                    {parsed.domains.map((d) => (
                      <tr
                        key={d.domain}
                        className="border-b border-border/60 last:border-0"
                      >
                        <td className="py-1.5 font-mono">{d.domain}</td>
                        <td className="py-1.5 font-mono text-muted-foreground">
                          {d.orderEmail}
                        </td>
                        <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                          {d.inboxes}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
            <AlertIcon size={16} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
          <button
            type="button"
            className="pv-btn-primary"
            disabled={!canStart}
            onClick={handleStart}
          >
            {starting ? <Spinner /> : <FireIcon size={16} />}
            {delayNum > 0 ? `Schedule in ${delayNum}h` : "Start warmup"}
          </button>
          <span className="text-xs text-muted-foreground">
            Updates the Domains sheet, then checks Plusvibe hourly for up to 7
            days — runs on the server, safe to close the tab.
          </span>
        </div>
      </div>

      {/* Jobs */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold">Runs</h2>
        {jobs.length === 0 ? (
          <EmptyState icon={<FireIcon />} title="No runs yet">
            Upload a mailbox CSV and start — progress appears here and keeps
            going for days, even if you close the app.
          </EmptyState>
        ) : (
          jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              onAbort={async (id) => {
                await abortAzureWarmup(id);
                await refreshJobs();
              }}
              onResume={async (id) => {
                try {
                  await resumeAzureWarmup(id);
                  setToast("Run resumed");
                  await refreshJobs();
                } catch (err) {
                  setError(errMessage(err));
                }
              }}
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

const STATUS_META: Record<AzureJobStatus, { label: string; className: string }> = {
  waiting: { label: "Scheduled", className: "bg-blue-500/10 text-blue-600 dark:text-blue-400" },
  running: { label: "Running", className: "bg-blue-500/10 text-blue-600 dark:text-blue-400" },
  done: { label: "Done", className: "bg-success/10 text-success" },
  aborted: { label: "Aborted", className: "bg-muted text-muted-foreground" },
  interrupted: { label: "Interrupted", className: "bg-warning/10 text-warning" },
  error: { label: "Error", className: "bg-danger/10 text-danger" },
};

function JobCard({
  job,
  onAbort,
  onResume,
}: {
  job: AzureWarmupJob;
  onAbort: (id: string) => void;
  onResume: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const t = job.totals;
  const pct = t.inboxes > 0 ? Math.round((t.warmed / t.inboxes) * 100) : 0;
  const status = STATUS_META[job.status];
  const phaseLabel =
    job.status === "waiting"
      ? `Waiting — starts ${timeUntil(job.startsAt)}`
      : job.status !== "running"
        ? status.label
        : job.phase === "sheet"
          ? "Updating the Domains sheet"
          : job.phase === "polling"
            ? `Checking Plusvibe · check ${job.checks + 1}`
            : "Finishing";

  return (
    <div className="pv-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-medium ${status.className}`}
          >
            {job.status === "running" && <Spinner size={10} />} {status.label}
          </span>
          <span className="text-sm font-medium">{job.label}</span>
          <span className="text-xs text-muted-foreground">
            {job.workspaceName}
          </span>
        </div>
        <span className="text-xs text-muted-foreground">
          {relativeTime(job.createdAt)}
        </span>
      </div>

      <div className="mt-3">
        <div className="mb-1.5 flex items-center justify-between text-xs text-muted-foreground">
          <span className="flex items-center gap-2">
            {job.status === "running" && <Spinner size={12} />}
            {job.status === "waiting" && <ClockIcon size={12} />}
            {phaseLabel}
          </span>
          <span className="tabular-nums">
            {formatNumber(t.warmed)} / {formatNumber(t.inboxes)} warming · {pct}%
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full rounded-full transition-all duration-300 ${
              job.status === "error" ? "bg-danger" : "bg-blue-500"
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
        {job.status === "running" && job.nextCheckAt && job.phase === "polling" && (
          <div className="mt-1 text-[11px] text-muted-foreground">
            next check {timeUntil(job.nextCheckAt)} · stops{" "}
            {timeUntil(job.deadlineAt)}
          </div>
        )}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label="Domains" value={t.domains} />
        <Metric label="Found in Plusvibe" value={t.found} />
        <Metric label="Warming" value={t.warmed} tone="success" />
        <Metric
          label="Not yet in Plusvibe"
          value={job.missing.length}
          tone={job.missing.length > 0 ? "warning" : "muted"}
        />
      </div>

      {/* Sheet result */}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <SheetIcon size={14} className="text-muted-foreground" />
        {job.sheet.error ? (
          <span className="text-danger">Sheet: {job.sheet.error}</span>
        ) : job.sheet.attempted ? (
          <span className="text-muted-foreground">
            Sheet: {formatNumber(job.sheet.rowsUpdated)} domain
            {job.sheet.rowsUpdated === 1 ? "" : "s"} set to “Warming Up”
            {job.sheet.notFound.length > 0 &&
              ` · ${job.sheet.notFound.length} not found in the tab`}
          </span>
        ) : (
          <span className="text-muted-foreground">Sheet: pending</span>
        )}
      </div>

      {job.errors.length > 0 && (
        <div className="pv-scroll mt-3 max-h-28 overflow-y-auto rounded-xl border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
          {job.errors.map((e, i) => (
            <div key={i} className="border-b border-warning/20 py-1 last:border-0">
              {e}
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {(job.status === "running" || job.status === "waiting") && (
          <button
            type="button"
            className="pv-btn-ghost"
            onClick={() => onAbort(job.id)}
          >
            Abort
          </button>
        )}
        {(job.status === "interrupted" || job.status === "error") && (
          <button
            type="button"
            className="pv-btn-ghost"
            onClick={() => onResume(job.id)}
          >
            Resume
          </button>
        )}
        <button
          type="button"
          className="pv-btn-ghost"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide details" : "Details"}
        </button>
        {job.missing.length > 0 && (
          <button
            type="button"
            className="pv-btn-ghost"
            onClick={() => downloadMissing(job)}
          >
            <DownloadIcon size={14} />
            Missing inboxes
          </button>
        )}
      </div>

      {job.status === "interrupted" && (
        <p className="mt-2 text-xs text-warning">
          Interrupted by a server restart. Everything already warming is
          unaffected — Resume picks up from where it stopped.
        </p>
      )}

      {open && (
        <div className="mt-3 space-y-3">
          <div className="pv-scroll max-h-64 overflow-y-auto rounded-xl border border-border">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Domain</th>
                  <th className="px-3 py-2 font-medium">Tenant email</th>
                  <th className="px-3 py-2 text-right font-medium">Found</th>
                  <th className="px-3 py-2 text-right font-medium">Warming</th>
                  <th className="px-3 py-2 text-right font-medium">Sheet</th>
                </tr>
              </thead>
              <tbody>
                {job.domains.map((d) => (
                  <tr
                    key={d.domain}
                    className="border-b border-border/70 last:border-0"
                  >
                    <td className="px-3 py-2 font-mono">{d.domain}</td>
                    <td className="px-3 py-2 font-mono text-muted-foreground">
                      {d.orderEmail}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {d.found}/{d.total}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {d.warmed === d.total ? (
                        <span className="text-success">{d.warmed}/{d.total}</span>
                      ) : (
                        <span>{d.warmed}/{d.total}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {d.sheetUpdated ? (
                        <span className="text-success">✓</span>
                      ) : (
                        <span className="text-muted-foreground" title={d.sheetNote}>
                          —
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {job.missing.length > 0 && (
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">
                Not yet in Plusvibe ({formatNumber(job.missing.length)})
              </div>
              <div className="pv-scroll max-h-40 overflow-y-auto rounded-xl border border-border px-3 py-2 font-mono text-[11px] text-muted-foreground">
                {job.missing.slice(0, 300).map((e) => (
                  <div key={e}>{e}</div>
                ))}
                {job.missing.length > 300 && (
                  <div className="pt-1 italic">
                    …and {formatNumber(job.missing.length - 300)} more — use the
                    download for the full list.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function downloadMissing(job: AzureWarmupJob) {
  const csv = ["email", ...job.missing].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `missing-inboxes-${job.id.slice(0, 8)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function Metric({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "success" | "warning" | "muted";
}) {
  const color =
    tone === "success"
      ? "text-success"
      : tone === "warning"
        ? "text-warning"
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

function timeUntil(ts: number): string {
  const diff = ts - Date.now();
  if (diff <= 0) return "now";
  const m = Math.round(diff / 60000);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
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

function errMessage(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
