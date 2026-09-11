"use client";

import { useState } from "react";
import { formatNumber } from "@/lib/format";
import { EmptyState, Spinner, RemoveJobButton } from "@/components/ui";
import { PlayIcon } from "@/components/icons";
import {
  STEP_LABELS,
  type StartOutreachJob,
  type StartOutreachStatus,
  type StepRecord,
  type StepState,
} from "@/lib/jobs/start-outreach-types";

const STATUS_META: Record<StartOutreachStatus, { label: string; className: string }> = {
  running: { label: "Running", className: "bg-accent/10 text-accent" },
  done: { label: "Done", className: "bg-success/10 text-success" },
  aborted: { label: "Stopped", className: "bg-muted text-muted-foreground" },
  interrupted: { label: "Interrupted", className: "bg-warning/10 text-warning" },
  error: { label: "Error", className: "bg-danger/10 text-danger" },
};

const STEP_META: Record<StepState, { label: string; className: string }> = {
  pending: { label: "Waiting", className: "text-muted-foreground" },
  running: { label: "Running", className: "text-accent" },
  done: { label: "Done", className: "text-success" },
  partial: { label: "Partly", className: "text-warning" },
  error: { label: "Failed", className: "text-danger" },
  skipped: { label: "Skipped", className: "text-muted-foreground" },
};

export function JobsPanel({
  jobs,
  highlightJobId,
  onAbort,
  onRemove,
}: {
  jobs: StartOutreachJob[];
  highlightJobId: string | null;
  onAbort: (id: string) => void | Promise<void>;
  onRemove: (id: string) => void | Promise<void>;
}) {
  if (jobs.length === 0) {
    return (
      <EmptyState icon={<PlayIcon />} title="No runs yet">
        Runs appear here and keep going even if you close the tab.
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
  job: StartOutreachJob;
  highlight: boolean;
  onAbort: (id: string) => void | Promise<void>;
  onRemove: (id: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const status = STATUS_META[job.status];
  const finished = job.steps.filter((s) => s.state !== "pending" && s.state !== "running").length;
  const pct = Math.round((finished / job.steps.length) * 100);

  return (
    <div className={`pv-card p-4 sm:p-5 ${highlight ? "ring-2 ring-accent/40" : ""}`} data-job={job.id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${status.className}`}>
            {job.status === "running" && <Spinner size={10} />} {status.label}
          </span>
          <span className="text-sm font-medium">{job.label}</span>
        </div>
        <span className="text-xs text-muted-foreground">{relativeTime(job.createdAt)}</span>
      </div>

      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full transition-all duration-300 ${job.status === "error" ? "bg-danger" : "bg-accent"}`}
          style={{ width: `${pct}%` }}
        />
      </div>

      <ol className="mt-3 space-y-1.5 text-xs" data-steps>
        {job.steps.map((s) => (
          <StepLine key={s.key} step={s} />
        ))}
      </ol>

      {job.status === "interrupted" && (
        <p className="mt-2 text-xs text-warning">
          Interrupted by a server restart. What each step managed is listed above;
          fetch again to see where the inboxes are now.
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {job.status === "running" && (
          <button type="button" className="pv-btn-ghost" onClick={() => void onAbort(job.id)}>
            Stop run
          </button>
        )}
        {(job.errors.length > 0 || job.notMoved.length > 0 || job.settings.length > 0) && (
          <button type="button" className="pv-btn-ghost" onClick={() => setOpen((v) => !v)}>
            {open ? "Hide details" : "Details"}
          </button>
        )}
        {job.status !== "running" && <RemoveJobButton onRemove={() => onRemove(job.id)} />}
      </div>

      {open && (
        <div className="mt-3 space-y-3 text-xs">
          {job.settings.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {job.settings.map((s) => (
                <span key={s.key} className="pv-chip" title={s.apiField}>
                  {s.label} <span className="ml-1 font-medium">{s.value}</span>
                </span>
              ))}
            </div>
          )}
          {job.notMoved.length > 0 && (
            <div className="pv-scroll max-h-32 overflow-y-auto rounded-xl border border-border p-3 text-warning">
              Not found in {job.destination.name} after the move ({formatNumber(job.notMoved.length)}):{" "}
              {job.notMoved.join(", ")}
            </div>
          )}
          {job.errors.length > 0 && (
            <div className="pv-scroll max-h-40 overflow-y-auto rounded-xl border border-border p-3 text-danger">
              {job.errors.map((e, i) => (
                <div key={i} className="py-0.5">
                  {e}
                </div>
              ))}
              {job.errorsTruncated && <div className="py-0.5 text-muted-foreground">Error list truncated.</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StepLine({ step }: { step: StepRecord }) {
  const meta = STEP_META[step.state];
  const count =
    step.state === "skipped" || step.state === "pending"
      ? ""
      : step.total > 0
        ? `${formatNumber(step.done)} / ${formatNumber(step.total)}`
        : step.done > 0
          ? formatNumber(step.done)
          : "";
  return (
    <li className="flex flex-wrap items-baseline gap-x-2" data-step={step.key} data-state={step.state}>
      <span className={`w-14 shrink-0 font-medium ${meta.className}`}>
        {step.state === "running" ? <Spinner size={10} /> : null} {meta.label}
      </span>
      <span>{STEP_LABELS[step.key]}</span>
      {count && <span className="tabular-nums text-muted-foreground">{count}</span>}
      {step.note && <span className="text-muted-foreground">· {step.note}</span>}
      {step.error && <span className="text-danger">· {step.error}</span>}
    </li>
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
