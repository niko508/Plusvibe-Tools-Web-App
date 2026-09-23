"use client";

import { useState } from "react";
import type { CampaignTypesJob, CampaignTypesStatus, PhaseState, SourceRun } from "@/lib/jobs/campaign-types-types";
import { JOB_PHASE_ORDER, PHASE_ORDER, jobPhaseLabel, phaseLabel } from "@/lib/jobs/campaign-types-types";
import { describeKinds } from "@/lib/campaign-types/kinds";
import { describeRule } from "@/lib/campaign-types/segments";
import { formatNumber } from "@/lib/format";
import { Spinner, RemoveJobButton } from "@/components/ui";
import { CheckIcon, AlertIcon } from "@/components/icons";

const STATUS_META: Record<CampaignTypesStatus, { label: string; className: string }> = {
  queued: { label: "Queued", className: "bg-muted text-muted-foreground" },
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
  const status = STATUS_META[job.status] ?? STATUS_META.error;
  const running = job.status === "running";
  const queued = job.status === "queued";

  // A record persisted by an older build can be missing whole sections. The
  // server migrates what it loads, but normalising here too means a shape this
  // build has never seen degrades to an empty section instead of throwing and
  // taking the entire page down with it.
  const sources = job.sources ?? [];
  const segmenting = job.segmenting ?? { rules: [], leadsFound: 0, stayed: 0, unmapped: 0, unmappedSegments: [], plannedTotal: 0, processed: 0, moved: 0 };
  const rules = segmenting.rules ?? [];
  const tagging = job.tagging ?? { targets: [], tagsCreated: [] };
  const tagTargets = tagging.targets ?? [];
  const errors = job.errors ?? [];
  const phaseStates = job.phaseStates ?? { segmenting: "pending", building: "pending", tagging: "pending" };

  const sourcesDone = sources.filter((s) => s.state === "done" || s.state === "error").length;

  return (
    <div className="pv-card p-4 sm:p-5" data-job={job.id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${status.className}`}>
            {running && <Spinner size={10} />} {status.label}
            {queued && job.queuePosition ? (job.queuePosition === 1 ? " · next" : ` · ${ordinal(job.queuePosition)} in line`) : ""}
          </span>
          <span className="truncate text-sm font-medium">{job.label}</span>
          {job.mode === "move" && (
            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">Move leads</span>
          )}
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(job.createdAt)}</span>
      </div>

      {/* A fix run has one phase of its own: read, take the segment, move. */}
      {job.mode === "fix" && job.allocation && (
        <div className="mt-4 space-y-2 text-sm" data-allocation>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <span className="font-medium">
              Moving “{job.allocation.segment}” leads
            </span>
            <span className="text-xs tabular-nums text-muted-foreground">
              {formatNumber(job.allocation.moved)} / {formatNumber(job.allocation.matched)} moved
              {job.allocation.stranded > 0 ? ` · ${formatNumber(job.allocation.stranded)} stayed put` : ""}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {formatNumber(job.allocation.leadsFound)} lead{job.allocation.leadsFound === 1 ? "" : "s"} read from{" "}
            {job.allocation.sources.map((x) => x.campaignName).join(", ") || "nothing"}
          </p>
          <div className="space-y-1">
            {job.allocation.destinations.map((d) => (
              <div key={d.campaignId} className="flex flex-wrap items-baseline justify-between gap-x-3 rounded-lg border border-border/70 px-2.5 py-1.5" data-alloc-dest={d.campaignId}>
                <span className="min-w-0 truncate text-xs">{d.campaignName}</span>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {formatNumber(d.moved)} / {formatNumber(d.planned)}
                  {d.unmoved > 0 ? ` · ${formatNumber(d.unmoved)} did not arrive` : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* The three phases */}
      {job.mode !== "fix" && (
      <ol className="mt-4 space-y-2.5">
        {JOB_PHASE_ORDER.map((phase, i) => {
          const state = phaseStates[phase] ?? "pending";
          let summary = "";
          if (state === "skipped") summary = phase === "segmenting" ? "no segment rows" : "skipped";
          else if (state !== "pending") {
            if (phase === "segmenting") {
              summary =
                state === "running" && segmenting.plannedTotal > 0
                  ? `${formatNumber(segmenting.processed)} / ${formatNumber(segmenting.plannedTotal)} leads`
                  : segmentSummary(segmenting);
            } else if (phase === "building") {
              summary = `${sourcesDone} / ${sources.length} original${sources.length === 1 ? "" : "s"}`;
            } else {
              const done = tagTargets.filter((t) => t.state === "done").length;
              const removed = tagTargets.filter((t) => t.removed).length;
              summary = `${done} / ${tagTargets.length} tagged${removed ? ` · ${removed} had the other pool's tag taken off` : ""}${tagging.tagsCreated?.length ? ` · created ${tagging.tagsCreated.join(", ")}` : ""}`;
            }
          }
          return (
            <li key={phase} className="flex gap-3">
              <StepBullet index={i + 1} state={state} isCurrent={running && job.phase === phase} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className={`text-sm ${state === "pending" ? "text-muted-foreground" : "font-medium"}`}>{jobPhaseLabel(phase, job.mode)}</span>
                  <span className="text-xs tabular-nums text-muted-foreground">{summary}</span>
                </div>
                {phase === "segmenting" && segmenting.plannedTotal > 0 && (
                  <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-accent transition-all duration-300"
                      style={{ width: `${Math.round((segmenting.processed / segmenting.plannedTotal) * 100)}%` }}
                    />
                  </div>
                )}
                {phase === "segmenting" && rules.length > 0 && state !== "pending" && state !== "skipped" && (
                  <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4" data-segment-tiles>
                    {rules.map((r, j) => (
                      <Metric
                        key={j}
                        label={describeRule(r)}
                        sub={`${formatNumber(r.moved)} of ${formatNumber(r.planned)} moved${r.unmoved ? ` · ${formatNumber(r.unmoved)} stayed` : ""}`}
                        value={r.planned}
                        tone={r.state === "error" ? "danger" : undefined}
                      />
                    ))}
                  </div>
                )}
                {phase === "building" && state !== "pending" && (
                  <div className="mt-2 space-y-2">
                    {sources.map((s) => (
                      <SourceBlock key={s.campaignId || s.campaignName} source={s} mode={job.mode} running={running} />
                    ))}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      )}

      {errors.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {errors.slice(0, open ? undefined : 2).map((e, i) => (
            <p key={i} className="flex gap-1.5 text-xs text-warning">
              <AlertIcon size={13} className="mt-0.5 shrink-0" />
              <span>{e}</span>
            </p>
          ))}
          {errors.length > 2 && !open && (
            <button type="button" className="text-xs text-muted-foreground underline" onClick={() => setOpen(true)}>
              {errors.length - 2} more
            </button>
          )}
        </div>
      )}

      {queued && (
        <p className="mt-2 text-xs text-muted-foreground">
          Waiting for the job ahead to finish. Nothing has been created for this one yet — jobs run one at a time so the campaigns come out in order.
        </p>
      )}

      {job.status === "interrupted" && (
        <p className="mt-2 text-xs text-warning">
          {job.startedAt
            ? "Interrupted by a server restart. Leads already moved are in their new campaigns — start again to finish the rest."
            : "Still queued when the server restarted, so it never began. Nothing was created — start it again."}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {running || queued ? (
          <button type="button" className="pv-btn-ghost" onClick={() => onAbort(job.id)}>
            {queued ? "Cancel" : "Stop task"}
          </button>
        ) : (
          <RemoveJobButton onRemove={() => onRemove(job.id)} />
        )}
        <button type="button" className="pv-btn-ghost" onClick={() => setOpen((v) => !v)}>
          {open ? "Hide details" : "Details"}
        </button>
      </div>

      {open && (
        <div className="mt-3 space-y-3 rounded-xl border border-border p-3 text-xs">
          <Detail label="Workspace" value={job.workspaceName || "—"} />
          <Detail label="Campaign types" value={describeKinds(job.kinds ?? []) || "—"} />
          {rules.length > 0 && (
            <Detail
              label="Segments"
              value={`${formatNumber(segmenting.leadsFound)} leads read · ${segmentSummary(segmenting)}${
                segmenting.unmappedSegments?.length ? ` · not on any row: ${segmenting.unmappedSegments.map((s) => `"${s}"`).join(", ")}` : ""
              }`}
            />
          )}
          {sources.map((s) => (
            <SourceDetails key={s.campaignId || s.campaignName} source={s} many={sources.length > 1} />
          ))}
          {tagTargets.map((t) => (
            <Detail
              key={`tag-${t.campaignId}`}
              label={`${t.tag} · ${shortName(t.name)}`}
              value={t.state === "error" ? t.error || "failed" : t.removed ? `${t.state} · ${t.removed} taken off` : t.state}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** One original inside the building phase: its four steps and where its leads went. */
function SourceBlock({ source, mode, running }: { source: SourceRun; mode: CampaignTypesJob["mode"]; running: boolean }) {
  const moving = source.moving ?? { targets: [], staysInSource: 0, processed: 0, plannedTotal: 0 };
  const targets = moving.targets ?? [];
  const created = source.created ?? [];
  const activation = source.activation ?? [];
  const phaseStates = source.phaseStates ?? { sorting: "pending", duplicating: "pending", moving: "pending", activating: "pending" };
  return (
    <div className="rounded-xl border border-border/70 p-2.5" data-source-block={source.campaignId}>
      <div className="mb-2 flex items-center gap-2">
        <span className="truncate text-xs font-medium">{source.campaignName}</span>
        {source.state === "error" && <span className="shrink-0 rounded-full bg-danger/10 px-2 py-0.5 text-[11px] text-danger">problem</span>}
        {source.state === "done" && <CheckIcon size={13} className="shrink-0 text-success" />}
        {source.state === "running" && <Spinner size={11} />}
      </div>
      <ol className="space-y-1.5">
        {PHASE_ORDER.map((phase, i) => {
          const state = phaseStates[phase] ?? "pending";
          return (
            <li key={phase} className="flex items-center gap-2">
              <StepBullet index={i + 1} state={state} isCurrent={running && source.state === "running" && source.phase === phase} small />
              <span className={`flex-1 text-xs ${state === "pending" ? "text-muted-foreground" : ""}`}>{phaseLabel(phase, mode)}</span>
              <span className="text-[11px] tabular-nums text-muted-foreground">{phaseSummary({ created, activation, moving, sorting: source.sorting }, phase, state, mode)}</span>
            </li>
          );
        })}
      </ol>
      {moving.plannedTotal > 0 && (
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <Metric label={shortName(source.campaignName)} sub="stays put" value={moving.staysInSource} />
          {targets
            .filter((t) => t.state !== "skipped")
            .map((t) => (
              <Metric
                key={t.role}
                label={shortName(t.name)}
                sub={`${formatNumber(t.moved)} of ${formatNumber(t.planned)} moved${t.unmoved ? ` · ${formatNumber(t.unmoved)} stayed` : ""}`}
                value={t.planned}
                tone={t.state === "error" ? "danger" : undefined}
              />
            ))}
        </div>
      )}
    </div>
  );
}

function SourceDetails({ source, many }: { source: SourceRun; many: boolean }) {
  const sorting = source.sorting ?? { leadsFound: 0, microsoft: 0, other: 0, domainsTotal: 0, domainsResolved: 0, unresolvedDomains: 0, fromLeadField: 0 };
  const created = source.created ?? [];
  const activation = source.activation ?? [];
  return (
    <div className="space-y-2 border-t border-border/60 pt-2 first:border-t-0 first:pt-0">
      {many && <div className="font-medium">{source.campaignName}</div>}
      <Detail label="Leads sorted" value={`${formatNumber(sorting.leadsFound)} not-contacted · ${sortBreakdown(sorting)}`} />
      <Detail
        label="Domains resolved"
        value={`${formatNumber(sorting.domainsResolved)} / ${formatNumber(sorting.domainsTotal)}${sorting.unresolvedDomains > 0 ? ` · ${formatNumber(sorting.unresolvedDomains)} unresolved` : ""}`}
      />
      {created.map((c) => (
        <Detail
          key={c.role}
          label={c.name}
          value={c.state === "error" ? c.error || "failed" : c.state === "skipped" ? `skipped — ${c.error ?? "not found"}` : c.reused ? "already existed — reused" : c.campaignId ? "duplicated with sub-sequences" : c.state}
          mono
        />
      ))}
      {created
        .filter((c) => c.optOut)
        .map((c) => (
          <Detail
            key={`optout-${c.role}`}
            label={`Opt-out copy · ${shortName(c.name)}`}
            value={
              c.optOut!.state === "error"
                ? c.optOut!.error || "failed"
                : c.optOut!.applied.length > 0
                  ? `added to step 1 ${c.optOut!.applied.join(", ")}`
                  : c.optOut!.alreadyPresent.length > 0
                    ? `already present on ${c.optOut!.alreadyPresent.join(", ")}`
                    : c.optOut!.state
            }
          />
        ))}
      {created
        .filter((c) => c.signature)
        .map((c) => (
          <Detail
            key={`signature-${c.role}`}
            label={`Sign-off · ${shortName(c.name)}`}
            value={
              c.signature!.state === "error"
                ? c.signature!.error || "failed"
                : [
                    c.signature!.applied.length > 0 ? `swapped on step 1 ${c.signature!.applied.join(", ")}` : null,
                    c.signature!.alreadyPresent.length > 0 ? `already signed on ${c.signature!.alreadyPresent.join(", ")}` : null,
                    // Worth its own clause: these variations send exactly as
                    // the source does, which is the one outcome someone would
                    // not expect from a Signature campaign.
                    c.signature!.missing.length > 0 ? `nothing to swap on ${c.signature!.missing.join(", ")}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || c.signature!.state
            }
          />
        ))}
      {activation.map((a) => (
        <Detail key={`launch-${a.role}`} label={`Activate · ${shortName(a.name)}`} value={a.state === "error" ? a.error || "failed" : a.state} />
      ))}
    </div>
  );
}

function StepBullet({ index, state, isCurrent, small }: { index: number; state: PhaseState; isCurrent: boolean; small?: boolean }) {
  const base = `flex shrink-0 items-center justify-center rounded-full font-medium ${small ? "h-5 w-5 text-[10px]" : "h-6 w-6 text-[11px]"}`;
  const icon = small ? 11 : 13;
  if (state === "done") {
    return (
      <span className={`${base} bg-success/15 text-success`}>
        <CheckIcon size={icon} />
      </span>
    );
  }
  if (state === "error") {
    return (
      <span className={`${base} bg-danger/15 text-danger`}>
        <AlertIcon size={icon} />
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
        <Spinner size={small ? 10 : 12} />
      </span>
    );
  }
  return <span className={`${base} bg-muted text-muted-foreground`}>{index}</span>;
}

/** "1,234 moved · 300 already in place · 12 on no row" */
function segmentSummary(s: CampaignTypesJob["segmenting"]): string {
  const parts = [`${formatNumber(s.moved)} moved`];
  if (s.stayed > 0) parts.push(`${formatNumber(s.stayed)} already in place`);
  if (s.unmapped > 0) parts.push(`${formatNumber(s.unmapped)} on no row`);
  if (s.unmoved) parts.push(`${formatNumber(s.unmoved)} could not move`);
  return parts.join(" · ");
}

/**
 * The one-line summary shown to the right of each of an original's steps.
 *
 * Takes the already-normalised pieces rather than the raw record, so it cannot
 * be handed one with a section missing.
 */
function phaseSummary(
  parts: { created: SourceRun["created"]; activation: SourceRun["activation"]; moving: SourceRun["moving"]; sorting: SourceRun["sorting"] },
  phase: (typeof PHASE_ORDER)[number],
  state: PhaseState,
  mode: CampaignTypesJob["mode"]
): string {
  if (state === "pending") return "";
  if (state === "skipped") return "skipped";

  if (phase === "sorting") {
    const s = parts.sorting;
    if (state === "running" && s.domainsTotal > 0) return `${formatNumber(s.domainsResolved)} / ${formatNumber(s.domainsTotal)} domains`;
    if (s.leadsFound === 0) return state === "done" ? "no leads found" : "";
    return sortBreakdown(s);
  }

  if (phase === "duplicating") {
    const done = parts.created.filter((c) => c.state === "done").length;
    if (mode === "move") return `${done} / ${parts.created.length} found`;
    const reused = parts.created.filter((c) => c.reused).length;
    const base = `${done} / ${parts.created.length} campaigns`;
    return reused > 0 ? `${base} · ${reused} reused` : base;
  }

  if (phase === "activating") {
    const done = parts.activation.filter((a) => a.state === "done").length;
    return `${done} / ${parts.activation.length} launched`;
  }

  return `${formatNumber(parts.moving.processed)} / ${formatNumber(parts.moving.plannedTotal)} leads`;
}

function Metric({ label, sub, value, tone }: { label: string; sub: string; value: number; tone?: "danger" }) {
  return (
    <div className="rounded-xl border border-border p-2.5">
      <div className="truncate text-[11px] text-muted-foreground" title={label}>
        {label}
      </div>
      <div className={`mt-0.5 text-lg font-semibold tabular-nums ${tone === "danger" ? "text-danger" : ""}`}>{formatNumber(value)}</div>
      <div className="text-[11px] text-muted-foreground">{sub}</div>
    </div>
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-wrap gap-x-2">
      <span className="shrink-0 text-muted-foreground">{label}:</span>
      <span className={mono ? "font-mono" : ""}>{value}</span>
    </div>
  );
}

/**
 * "7,779 Microsoft · 5,000 Google · 1,544 other". The oldest records have no
 * Google count — their "other" was everything that was not Microsoft.
 */
function sortBreakdown(s: SourceRun["sorting"]): string {
  const parts = [`${formatNumber(s.microsoft)} Microsoft`];
  if (typeof s.google === "number") parts.push(`${formatNumber(s.google)} Google`);
  parts.push(`${formatNumber(s.other)} other`);
  return parts.join(" · ");
}

/** Trims a long campaign name down to something that fits a metric tile. */
function shortName(name: string): string {
  return name.length > 28 ? `${name.slice(0, 27)}…` : name;
}

/** "2nd", "3rd" — the queue never gets long enough for the teens to matter. */
function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th");
  return `${n}${suffix}`;
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
