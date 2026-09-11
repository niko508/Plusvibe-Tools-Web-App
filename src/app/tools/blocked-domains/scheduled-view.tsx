"use client";

import { useState } from "react";
import type { BlockedDomainJob } from "@/lib/jobs/blocked-domains-types";
import { describeNext } from "@/lib/blocked-domains/recheck";
import { formatNumber } from "@/lib/format";
import { EmptyState, Spinner } from "@/components/ui";
import { ClockIcon, GaugeIcon } from "@/components/icons";

// The domains still being watched, soonest check first.
//
// The home view says all of this per card, buried under the run's steps. This
// is the same information laid out as a schedule: which domains come up next,
// and when. A domain that was re-armed has a fresh run doing the watching, so
// its old record is left out even if its recheck flag is still on.

/** The records whose repeat checks are on, soonest first. */
export function watchedJobs(jobs: BlockedDomainJob[]): BlockedDomainJob[] {
  return jobs
    .filter((j) => j.recheck?.enabled && !j.rearmedAt)
    .sort((a, b) => (a.recheck?.nextAt ?? Infinity) - (b.recheck?.nextAt ?? Infinity));
}

/** Records that were watched and stopped being — ended on their own, or by hand. */
export function endedJobs(jobs: BlockedDomainJob[]): BlockedDomainJob[] {
  return jobs
    .filter((j) => j.recheck && !j.recheck.enabled && !j.rearmedAt)
    .sort((a, b) => lastRunAt(b) - lastRunAt(a));
}

function lastRunAt(j: BlockedDomainJob): number {
  const runs = j.recheck?.runs ?? [];
  return runs.length > 0 ? runs[runs.length - 1].at : j.updatedAt;
}

export function ScheduledView({
  jobs,
  busyId,
  onRecheck,
  everyDays,
  onRescheduleAll,
  rescheduling,
  rescheduled,
}: {
  jobs: BlockedDomainJob[];
  busyId: string | null;
  onRecheck: (id: string, action: "now" | "on" | "off") => void | Promise<void>;
  /** The gap between checks, as set on the Home tab. */
  everyDays: number;
  /** Puts every watched domain's next check that many days from now. */
  onRescheduleAll: () => void | Promise<void>;
  rescheduling: boolean;
  /** Said after a reschedule, so the effect is visible. */
  rescheduled: { count: number; days: number } | null;
}) {
  const watched = watchedJobs(jobs);
  const ended = endedJobs(jobs);
  const now = Date.now();
  const [armed, setArmed] = useState(false);

  if (watched.length === 0 && ended.length === 0) {
    return (
      <EmptyState icon={<ClockIcon />} title="Nothing is scheduled">
        When repeat checks are on, every domain that gets flagged is assessed
        again on a schedule and shows up here with its next date.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-sm font-semibold">
              Scheduled ({formatNumber(watched.length)})
            </h2>
            <span className="text-xs text-muted-foreground">
              Soonest first. Each check reads the last 7 days again and acts on
              what it says.
            </span>
          </div>
          {watched.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {rescheduled && (
                <span className="text-xs text-success" data-rescheduled>
                  {formatNumber(rescheduled.count)} domain
                  {rescheduled.count === 1 ? "" : "s"} now due in {rescheduled.days} days.
                </span>
              )}
              {armed && (
                <button
                  type="button"
                  className="pv-btn-ghost"
                  onClick={() => setArmed(false)}
                >
                  Cancel
                </button>
              )}
              {/* Two clicks: this moves every watched domain at once, and a
                  slip here would push the whole schedule out. */}
              <button
                type="button"
                data-reschedule-all
                className={`pv-btn-ghost disabled:opacity-50 ${armed ? "border-warning text-warning" : ""}`}
                disabled={rescheduling}
                title={`Puts every watched domain's next check ${everyDays} days from now, whatever it was. The gap itself is set on the Home tab.`}
                onClick={() => {
                  if (!armed) {
                    setArmed(true);
                    return;
                  }
                  setArmed(false);
                  void onRescheduleAll();
                }}
              >
                {rescheduling ? <Spinner size={14} /> : <ClockIcon size={14} />}
                {armed
                  ? `Really move all ${formatNumber(watched.length)}? Click again`
                  : `Reschedule all: next check in ${everyDays} days`}
              </button>
            </div>
          )}
        </div>
        {watched.length === 0 ? (
          <p className="pv-card p-4 text-sm text-muted-foreground">
            No domain is being watched right now.
          </p>
        ) : (
          <div className="pv-card divide-y divide-border">
            {watched.map((job) => (
              <ScheduledRow
                key={job.id}
                job={job}
                now={now}
                busy={busyId === job.id}
                onRecheck={onRecheck}
              />
            ))}
          </div>
        )}
      </div>

      {ended.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground">
            No longer watched ({formatNumber(ended.length)})
          </h2>
          <div className="pv-card divide-y divide-border">
            {ended.map((job) => (
              <EndedRow
                key={job.id}
                job={job}
                busy={busyId === job.id}
                onRecheck={onRecheck}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ScheduledRow({
  job,
  now,
  busy,
  onRecheck,
}: {
  job: BlockedDomainJob;
  now: number;
  busy: boolean;
  onRecheck: (id: string, action: "now" | "on" | "off") => void | Promise<void>;
}) {
  const recheck = job.recheck!;
  const inFlight = job.status === "working" || job.status === "deleting";
  const activeCount = job.inboxesActive ?? Math.max(0, job.inboxesFound - job.inboxesQuarantined);
  const runs = recheck.runs;
  const last = runs.length > 0 ? runs[runs.length - 1] : undefined;
  const due = recheck.nextAt !== undefined && recheck.nextAt <= now;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
      <div className="min-w-[200px] flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-medium">{job.domain}</span>
          {job.workspaceName && (
            <span className="pv-chip" title="Workspace">
              {job.workspaceName}
            </span>
          )}
          {job.sheet?.domainHost && (
            <span className="pv-chip" title="Domain Host, from the Domains sheet">
              {job.sheet.domainHost}
            </span>
          )}
          {job.inboxesFound > 0 && (
            <span
              className={`pv-chip ${activeCount === 0 ? "text-muted-foreground" : ""}`}
              title="Inboxes on this domain still sending, out of the total"
            >
              {formatNumber(activeCount)}/{formatNumber(job.inboxesFound)} sending
            </span>
          )}
          {job.status === "kept" && (
            <span className="rounded-full bg-success/10 px-2.5 py-1 text-xs font-medium text-success">
              Domain kept
            </span>
          )}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {last
            ? `Last checked ${dateLabel(last.at)}${
                last.domainReplyRateOoo !== undefined ? ` · domain at ${last.domainReplyRateOoo}%` : ""
              }${last.error ? ` · ${last.error}` : ""}`
            : `Flagged ${dateLabel(job.createdAt)}${
                job.performance?.domain?.basis && job.performance.domain.basis !== "none"
                  ? ` · domain at ${job.performance.domain.replyRateOoo}%`
                  : ""
              }`}
          {" · "}
          {runs.length} repeat check{runs.length === 1 ? "" : "s"} so far
        </p>
      </div>

      <div className="min-w-[180px] text-sm">
        <div className={`flex items-center gap-1.5 font-medium ${due ? "text-warning" : ""}`}>
          <ClockIcon size={14} />
          <span data-next-check>
            {recheck.nextAt !== undefined ? dateLabel(recheck.nextAt) : "not scheduled"}
          </span>
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {describeNext(recheck.nextAt, now)} · every {recheck.everyDays} days
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          className="pv-btn-ghost disabled:opacity-50"
          disabled={busy || inFlight}
          onClick={() => onRecheck(job.id, "now")}
          title="Read the last 7 days again now, and act on what it says"
        >
          {busy ? <Spinner /> : <GaugeIcon size={16} />}
          Check now
        </button>
        <button
          type="button"
          className="pv-btn-ghost disabled:opacity-50"
          disabled={busy || inFlight}
          onClick={() => onRecheck(job.id, "off")}
        >
          Stop watching
        </button>
      </div>
    </div>
  );
}

function EndedRow({
  job,
  busy,
  onRecheck,
}: {
  job: BlockedDomainJob;
  busy: boolean;
  onRecheck: (id: string, action: "now" | "on" | "off") => void | Promise<void>;
}) {
  const recheck = job.recheck!;
  const inFlight = job.status === "working" || job.status === "deleting";
  const runs = recheck.runs;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
      <div className="min-w-[200px] flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-medium text-muted-foreground">{job.domain}</span>
          {job.sheet?.domainHost && <span className="pv-chip">{job.sheet.domainHost}</span>}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {recheck.endedReason || "Switched off by hand."}
          {runs.length > 0 && ` · ${runs.length} repeat check${runs.length === 1 ? "" : "s"}, last ${dateLabel(runs[runs.length - 1].at)}`}
        </p>
      </div>
      <button
        type="button"
        className="pv-btn-ghost disabled:opacity-50"
        disabled={busy || inFlight}
        onClick={() => onRecheck(job.id, "on")}
      >
        Watch again
      </button>
    </div>
  );
}

/** "Mon 14 Sep" — the day, which is what a schedule is read in. */
export function dateLabel(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}
