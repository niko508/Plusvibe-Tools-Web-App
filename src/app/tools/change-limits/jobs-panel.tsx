"use client";

import { useState } from "react";
import { formatNumber } from "@/lib/format";
import { EmptyState, Spinner, RemoveJobButton } from "@/components/ui";
import { ZapIcon } from "@/components/icons";
import type {
  ChangeLimitsJob,
  ChangeLimitsStatus,
} from "@/lib/jobs/change-limits-types";

const STATUS_META: Record<ChangeLimitsStatus, { label: string; className: string }> = {
  running: { label: "Running", className: "bg-accent/10 text-accent" },
  done: { label: "Done", className: "bg-success/10 text-success" },
  aborted: { label: "Stopped", className: "bg-muted text-muted-foreground" },
  interrupted: { label: "Interrupted", className: "bg-warning/10 text-warning" },
  error: { label: "Error", className: "bg-danger/10 text-danger" },
};

export function JobsPanel({
  jobs,
  highlightJobId,
  onAbort,
  onRemove,
}: {
  jobs: ChangeLimitsJob[];
  highlightJobId: string | null;
  onAbort: (id: string) => void | Promise<void>;
  onRemove: (id: string) => void | Promise<void>;
}) {
  if (jobs.length === 0) {
    return (
      <EmptyState icon={<ZapIcon />} title="No runs yet">
        Fetch the inboxes, then apply the increase settings to the ones that
        qualify. The run appears here and keeps going even if you close the app.
      </EmptyState>
    );
  }
  return (
    <div className="space-y-3">
      {jobs.map((job) => (
        <JobCard
          key={job.id}
          job={job}
          highlight={job.id === highlightJobId}
          onAbort={onAbort}
          onRemove={onRemove}
        />
      ))}
    </div>
  );
}

function JobCard({
  job,
  highlight,
  onAbort,
  onRemove,
}: {
  job: ChangeLimitsJob;
  highlight: boolean;
  onAbort: (id: string) => void | Promise<void>;
  onRemove: (id: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const p = job.progress;
  const attempted = p.inboxesUpdated + p.inboxesFailed;
  const pct =
    p.inboxesTotal > 0
      ? Math.round((attempted / p.inboxesTotal) * 100)
      : job.status === "done"
        ? 100
        : 0;
  const status = STATUS_META[job.status];

  return (
    <div className={`pv-card p-4 sm:p-5 ${highlight ? "ring-2 ring-accent/40" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${status.className}`}>
            {job.status === "running" && <Spinner size={10} />} {status.label}
          </span>
          <span className="text-sm font-medium">{job.label}</span>
        </div>
        <span className="text-xs text-muted-foreground">{relativeTime(job.createdAt)}</span>
      </div>

      <div className="mt-3">
        <div className="mb-1.5 flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {formatNumber(p.workspacesDone)} / {formatNumber(p.workspacesTotal)} workspace
            {p.workspacesTotal === 1 ? "" : "s"}
          </span>
          <span className="tabular-nums">
            {formatNumber(attempted)} / {formatNumber(p.inboxesTotal)} inboxes
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full rounded-full transition-all duration-300 ${
              job.status === "error" ? "bg-danger" : "bg-accent"
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Metric label="Inboxes updated" value={p.inboxesUpdated} tone="success" />
        <Metric
          label="Failed"
          value={p.inboxesFailed}
          tone={p.inboxesFailed > 0 ? "danger" : "muted"}
        />
        <Metric label="Settings applied" value={job.settings.length} tone="default" />
      </div>

      {job.settings.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2">
          {job.settings.map((s) => (
            <li key={s.key} className="pv-chip" title={s.apiField}>
              {s.label} <span className="ml-1 font-medium">{s.value}</span>
            </li>
          ))}
        </ul>
      )}

      {job.status === "interrupted" && (
        <p className="mt-2 text-xs text-warning">
          Interrupted by a server restart. The inboxes already updated kept their
          new settings; fetch again and re-apply to finish the rest.
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {job.status === "running" && (
          <button type="button" className="pv-btn-ghost" onClick={() => void onAbort(job.id)}>
            Stop run
          </button>
        )}
        {(job.errors.length > 0 || job.groups.length > 0) && (
          <button type="button" className="pv-btn-ghost" onClick={() => setOpen((v) => !v)}>
            {open ? "Hide details" : "Details"}
          </button>
        )}
        {job.status !== "running" && <RemoveJobButton onRemove={() => onRemove(job.id)} />}
      </div>

      {open && (
        <div className="mt-3 space-y-3">
          <div className="pv-scroll max-h-56 overflow-y-auto rounded-xl border border-border">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Workspace</th>
                  <th className="px-3 py-2 text-right font-medium">Inboxes</th>
                  <th className="px-3 py-2 text-right font-medium">Updated</th>
                  <th className="px-3 py-2 text-right font-medium">Failed</th>
                </tr>
              </thead>
              <tbody>
                {job.groups.map((g) => (
                  <tr key={g.workspaceId} className="border-b border-border/70 last:border-0">
                    <td className="px-3 py-2">{g.workspaceName}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatNumber(g.total)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-success">
                      {formatNumber(g.updated)}
                    </td>
                    <td
                      className={`px-3 py-2 text-right tabular-nums ${
                        g.failed > 0 ? "text-danger" : "text-muted-foreground"
                      }`}
                    >
                      {formatNumber(g.failed)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {job.errors.length > 0 && (
            <div className="pv-scroll max-h-40 overflow-y-auto rounded-xl border border-border p-3 text-xs text-danger">
              {job.errors.map((e, i) => (
                <div key={i} className="py-0.5">
                  {e}
                </div>
              ))}
              {job.errorsTruncated && (
                <div className="py-0.5 text-muted-foreground">
                  Error list truncated.
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "default" | "success" | "danger" | "muted";
}) {
  const color =
    tone === "success"
      ? "text-success"
      : tone === "danger"
        ? "text-danger"
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

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.round(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(ts).toLocaleDateString();
}
