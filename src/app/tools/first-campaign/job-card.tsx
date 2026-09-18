"use client";

import { useState } from "react";
import type {
  FirstCampaignJob,
  FirstCampaignStatus,
  PhaseState,
} from "@/lib/jobs/first-campaign-types";
import { PHASE_ORDER, PHASE_LABELS } from "@/lib/jobs/first-campaign-types";
import { Spinner, RemoveJobButton } from "@/components/ui";
import { CheckIcon, AlertIcon } from "@/components/icons";

const STATUS_META: Record<
  FirstCampaignStatus,
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
  job: FirstCampaignJob;
  onAbort: (id: string) => void | Promise<void>;
  onRemove: (id: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const status = STATUS_META[job.status] ?? STATUS_META.error;
  const running = job.status === "running";

  // A record persisted by an older build can be missing whole sections. The
  // server migrates what it loads, but normalising here too means a shape this
  // build has never seen degrades to an empty section instead of throwing and
  // taking the whole page down with it.
  const labels = job.labels ?? [];
  const subsequences = job.subsequences ?? [];
  const errors = job.errors ?? [];
  const manualFollowUps = job.manualFollowUps ?? [];
  const parent = job.parent ?? {
    name: job.label ?? "",
    createState: "pending" as PhaseState,
    settingsState: "pending" as PhaseState,
    tagName: "Active",
  };

  const labelsCreated = labels.filter(
    (l) => l.state === "done" && !l.reused
  ).length;
  const labelsReused = labels.filter((l) => l.reused).length;
  const subsDone = subsequences.filter(
    (s) => s.createState === "done" && s.settingsState === "done"
  ).length;

  /** One line of detail under each phase heading. */
  function phaseDetail(phase: (typeof PHASE_ORDER)[number]): string {
    if (phase === "labels") {
      if (labels.length === 0) return "";
      const done = labels.filter((l) => l.state === "done").length;
      if (done < labels.length) return `${done} / ${labels.length} ready`;
      return labelsCreated > 0
        ? `${labelsCreated} created · ${labelsReused} already existed`
        : `all ${labels.length} already existed`;
    }
    if (phase === "parent") {
      if (parent.createState !== "done") return parent.name;
      const bits = [parent.reused ? "reused existing campaign" : "created"];
      if (parent.settingsState === "done") bits.push("settings applied");
      if (parent.tagMissing) bits.push(`no "${parent.tagName}" tag`);
      else if (parent.tagId) bits.push(`${parent.tagName} tag attached`);
      return bits.join(" · ");
    }
    return subsequences.length > 0
      ? `${subsDone} / ${subsequences.length} built`
      : "";
  }

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
        {PHASE_ORDER.map((phase, i) => {
          const phaseState = job.phaseStates?.[phase] ?? "pending";
          const detail = phaseDetail(phase);
          return (
            <li key={phase} className="flex gap-3">
              <StepBullet
                index={i + 1}
                state={phaseState}
                isCurrent={running && job.phase === phase}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span
                    className={`text-sm ${
                      phaseState === "pending" ? "text-muted-foreground" : ""
                    }`}
                  >
                    {PHASE_LABELS[phase]}
                  </span>
                  {detail && (
                    <span className="text-xs text-muted-foreground">
                      {detail}
                    </span>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      {errors.length > 0 && (
        <div className="mt-3 space-y-1">
          {(open ? errors : errors.slice(0, 2)).map((e, i) => (
            <p key={i} className="flex items-start gap-1.5 text-xs text-danger">
              <AlertIcon size={13} className="mt-0.5 shrink-0" />
              <span>{e}</span>
            </p>
          ))}
          {errors.length > 2 && !open && (
            <button
              type="button"
              className="text-xs text-muted-foreground underline"
              onClick={() => setOpen(true)}
            >
              {errors.length - 2} more
            </button>
          )}
        </div>
      )}

      {job.status === "interrupted" && (
        <p className="mt-2 text-xs text-warning">
          Interrupted by a server restart. Whatever was created is still there —
          run it again with the same campaign name and it picks up where it left
          off rather than making a second copy.
        </p>
      )}

      {job.status === "done" && manualFollowUps.length > 0 && (
        <div className="mt-3 rounded-xl border border-warning/30 bg-warning/5 p-3">
          <p className="text-xs font-medium text-warning">
            Two settings still need a manual pass
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
            {manualFollowUps.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          <p className="mt-1.5 text-xs text-muted-foreground">
            The Plusvibe API has no field for these, so the campaign keeps
            whatever default it was created with.
          </p>
        </div>
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
          <Detail
            label="Campaign"
            value={
              parent.createState === "error"
                ? parent.error || "failed"
                : parent.campaignId
                  ? `${parent.name}${parent.reused ? " (reused)" : ""}`
                  : parent.name
            }
          />
          <Detail
            label="Sending accounts"
            value={
              parent.tagMissing
                ? `no "${parent.tagName}" tag in this workspace — none attached`
                : parent.tagId
                  ? `${parent.tagName} tag`
                  : "—"
            }
          />
          {parent.scheduleForm && (
            <Detail
              label="Schedule accepted as"
              value={
                parent.scheduleForm === "object"
                  ? "a single object"
                  : "an array (the object form was rejected)"
              }
            />
          )}

          <div className="border-t border-border pt-2">
            <p className="mb-1 text-muted-foreground">Lead labels</p>
            <ul className="space-y-0.5">
              {labels.map((l) => (
                <li key={l.name} className="flex flex-wrap gap-x-2">
                  <span className="shrink-0">{l.name}</span>
                  <span className="text-muted-foreground">
                    {l.state === "error"
                      ? l.error || "failed"
                      : l.key
                        ? `${l.reused ? "existing" : "created"} · ${l.key}`
                        : l.state}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="border-t border-border pt-2">
            <p className="mb-1 text-muted-foreground">Sub-sequences</p>
            <ul className="space-y-0.5">
              {subsequences.map((s) => (
                <li key={s.name} className="flex flex-wrap gap-x-2">
                  <span className="shrink-0">{s.name}</span>
                  <span className="text-muted-foreground">
                    {s.createState === "error" || s.settingsState === "error"
                      ? s.error || "failed"
                      : s.campaignId
                        ? `${s.reused ? "reused" : "created"} · ${
                            s.steps > 0
                              ? `${s.steps} step${s.steps === 1 ? "" : "s"}, +${describeWait(
                                  s.firstWait,
                                  s.firstWaitUnit
                                )}`
                              : "no emails yet"
                          } · ${(s.labelNames ?? []).join(", ")}`
                        : s.createState}
                  </span>
                </li>
              ))}
            </ul>
          </div>
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

/** "1d", "120m" — compact enough to sit inline on a sub-sequence row. */
function describeWait(
  value: number | undefined,
  unit: "days" | "minutes" | undefined
): string {
  if (typeof value !== "number") return "?";
  return `${value}${unit === "minutes" ? "m" : "d"}`;
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap gap-x-2">
      <span className="shrink-0 text-muted-foreground">{label}:</span>
      <span>{value}</span>
    </div>
  );
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
