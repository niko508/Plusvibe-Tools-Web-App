"use client";

import { useState } from "react";
import type {
  CampaignTypesJob,
  CampaignTypesStatus,
  PhaseState,
} from "@/lib/jobs/campaign-types-types";
import {
  PHASE_ORDER,
  PHASE_LABELS,
} from "@/lib/jobs/campaign-types-types";
import { formatNumber } from "@/lib/format";
import { Spinner, RemoveJobButton } from "@/components/ui";
import { CheckIcon, AlertIcon } from "@/components/icons";

const STATUS_META: Record<
  CampaignTypesStatus,
  { label: string; className: string }
> = {
  running: { label: "Running", className: "bg-accent/10 text-accent" },
  done: { label: "Done", className: "bg-success/10 text-success" },
  aborted: { label: "Stopped", className: "bg-muted text-muted-foreground" },
  interrupted: { label: "Interrupted", className: "bg-warning/10 text-warning" },
  error: { label: "Error", className: "bg-danger/10 text-danger" },
};

export function JobCard({
  job,
  onAbort,
  onRemove,
}: {
  job: CampaignTypesJob;
  onAbort: (id: string) => void | Promise<void>;
  onRemove: (id: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const status = STATUS_META[job.status];
  const running = job.status === "running";

  return (
    <div className="pv-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${status.className}`}
          >
            {running && <Spinner size={10} />} {status.label}
          </span>
          <span className="truncate text-sm font-medium">{job.label}</span>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          {relativeTime(job.createdAt)}
        </span>
      </div>

      {/* The three steps */}
      <ol className="mt-4 space-y-2.5">
        {PHASE_ORDER.map((phase, i) => (
          <li key={phase} className="flex gap-3">
            <StepBullet
              index={i + 1}
              state={job.phaseStates[phase]}
              isCurrent={running && job.phase === phase}
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span
                  className={`text-sm ${
                    job.phaseStates[phase] === "pending"
                      ? "text-muted-foreground"
                      : "font-medium"
                  }`}
                >
                  {PHASE_LABELS[phase]}
                </span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {phaseSummary(job, phase)}
                </span>
              </div>
              {phase === "moving" && job.moving.plannedTotal > 0 && (
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-accent transition-all duration-300"
                    style={{
                      width: `${Math.round(
                        (job.moving.processed / job.moving.plannedTotal) * 100
                      )}%`,
                    }}
                  />
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>

      {/* Where the leads went */}
      {job.moving.plannedTotal > 0 && (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric
            label={shortName(job.label)}
            sub="stays put"
            value={job.moving.staysInSource}
          />
          {job.moving.targets.map((t) => (
            <Metric
              key={t.role}
              label={shortName(t.name)}
              sub={`${formatNumber(t.moved)} of ${formatNumber(t.planned)} moved`}
              value={t.planned}
              tone={t.state === "error" ? "danger" : undefined}
            />
          ))}
        </div>
      )}

      {job.errors.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {job.errors.slice(0, open ? undefined : 2).map((e, i) => (
            <p key={i} className="flex gap-1.5 text-xs text-warning">
              <AlertIcon size={13} className="mt-0.5 shrink-0" />
              <span>{e}</span>
            </p>
          ))}
          {job.errors.length > 2 && !open && (
            <button
              type="button"
              className="text-xs text-muted-foreground underline"
              onClick={() => setOpen(true)}
            >
              {job.errors.length - 2} more
            </button>
          )}
        </div>
      )}

      {job.status === "interrupted" && (
        <p className="mt-2 text-xs text-warning">
          Interrupted by a server restart. Leads already moved are in their new
          campaigns — start again to finish the rest.
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {running ? (
          <button
            type="button"
            className="pv-btn-ghost"
            onClick={() => onAbort(job.id)}
          >
            Stop task
          </button>
        ) : (
          <RemoveJobButton onRemove={() => onRemove(job.id)} />
        )}
        <button
          type="button"
          className="pv-btn-ghost"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide details" : "Details"}
        </button>
      </div>

      {open && (
        <div className="mt-3 space-y-3 rounded-xl border border-border p-3 text-xs">
          <Detail label="Workspace" value={job.workspaceName || "—"} />
          {job.campaigns.map((c) => (
            <Detail key={c.role} label={c.role} value={c.name} mono />
          ))}
          <Detail
            label="Leads sorted"
            value={`${formatNumber(job.sorting.leadsFound)} not-contacted · ${formatNumber(
              job.sorting.microsoft
            )} Microsoft · ${formatNumber(job.sorting.other)} other`}
          />
          <Detail
            label="Domains resolved"
            value={`${formatNumber(job.sorting.domainsResolved)} / ${formatNumber(
              job.sorting.domainsTotal
            )}${
              job.sorting.unresolvedDomains > 0
                ? ` · ${formatNumber(job.sorting.unresolvedDomains)} unresolved`
                : ""
            }`}
          />
          {job.optOut.map((t) => (
            <Detail
              key={t.role}
              label={`Opt-out copy · ${shortName(t.name)}`}
              value={
                t.state === "error"
                  ? t.error || "failed"
                  : t.applied.length > 0
                    ? `added to step 1 ${t.applied.join(", ")}`
                    : t.alreadyPresent.length > 0
                      ? `already present on ${t.alreadyPresent.join(", ")}`
                      : t.state
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function StepBullet({
  index,
  state,
  isCurrent,
}: {
  index: number;
  state: PhaseState;
  isCurrent: boolean;
}) {
  const base =
    "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-medium";
  if (state === "done") {
    return (
      <span className={`${base} bg-success/15 text-success`}>
        <CheckIcon size={13} />
      </span>
    );
  }
  if (state === "error") {
    return (
      <span className={`${base} bg-danger/15 text-danger`}>
        <AlertIcon size={13} />
      </span>
    );
  }
  if (state === "skipped") {
    return (
      <span className={`${base} bg-muted text-muted-foreground`} title="Skipped">
        –
      </span>
    );
  }
  if (state === "running" || isCurrent) {
    return (
      <span className={`${base} bg-accent/15 text-accent`}>
        <Spinner size={12} />
      </span>
    );
  }
  return (
    <span className={`${base} bg-muted text-muted-foreground`}>{index}</span>
  );
}

function phaseSummary(
  job: CampaignTypesJob,
  phase: (typeof PHASE_ORDER)[number]
): string {
  const state = job.phaseStates[phase];
  if (state === "pending") return "";
  if (state === "skipped") return "skipped";

  if (phase === "sorting") {
    const s = job.sorting;
    if (state === "running" && s.domainsTotal > 0) {
      return `${formatNumber(s.domainsResolved)} / ${formatNumber(s.domainsTotal)} domains`;
    }
    if (s.leadsFound === 0) return state === "done" ? "no leads found" : "";
    return `${formatNumber(s.microsoft)} Microsoft · ${formatNumber(s.other)} other`;
  }

  if (phase === "optOutCopy") {
    const done = job.optOut.filter((t) => t.state === "done").length;
    return `${done} / ${job.optOut.length} campaigns`;
  }

  return `${formatNumber(job.moving.processed)} / ${formatNumber(job.moving.plannedTotal)} leads`;
}

function Metric({
  label,
  sub,
  value,
  tone,
}: {
  label: string;
  sub: string;
  value: number;
  tone?: "danger";
}) {
  return (
    <div className="rounded-xl border border-border p-2.5">
      <div className="truncate text-[11px] text-muted-foreground" title={label}>
        {label}
      </div>
      <div
        className={`mt-0.5 text-lg font-semibold tabular-nums ${
          tone === "danger" ? "text-danger" : ""
        }`}
      >
        {formatNumber(value)}
      </div>
      <div className="text-[11px] text-muted-foreground">{sub}</div>
    </div>
  );
}

function Detail({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-x-2">
      <span className="shrink-0 text-muted-foreground">{label}:</span>
      <span className={mono ? "font-mono" : ""}>{value}</span>
    </div>
  );
}

/** Trims a long campaign name down to something that fits a metric tile. */
function shortName(name: string): string {
  return name.length > 28 ? `${name.slice(0, 27)}…` : name;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
