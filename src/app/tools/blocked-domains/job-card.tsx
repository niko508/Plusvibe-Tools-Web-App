"use client";

import { useState } from "react";
import type {
  BlockedDomainJob,
  BlockedDomainStatus,
  PhaseState,
} from "@/lib/jobs/blocked-domains-types";
import { PHASE_ORDER, PHASE_LABELS } from "@/lib/jobs/blocked-domains-types";
import { REASON_LABELS } from "@/lib/blocked-domains/performance";
import { formatNumber } from "@/lib/format";
import { Spinner, RemoveJobButton } from "@/components/ui";
import {
  CheckIcon,
  AlertIcon,
  ClockIcon,
  GaugeIcon,
  TrashIcon,
  RefreshIcon,
} from "@/components/icons";
import { describeNext } from "@/lib/blocked-domains/recheck";

const STATUS_META: Record<
  BlockedDomainStatus,
  { label: string; className: string }
> = {
  working: { label: "Working", className: "bg-accent/10 text-accent" },
  kept: { label: "Domain kept — still replying", className: "bg-success/10 text-success" },
  awaiting_confirmation: {
    label: "Needs your confirmation",
    className: "bg-warning/10 text-warning",
  },
  deleting: { label: "Deleting", className: "bg-accent/10 text-accent" },
  done: { label: "Done", className: "bg-success/10 text-success" },
  dismissed: { label: "Dismissed", className: "bg-muted text-muted-foreground" },
  error: { label: "Error", className: "bg-danger/10 text-danger" },
  interrupted: { label: "Interrupted", className: "bg-warning/10 text-warning" },
};

export function JobCard({
  job,
  onConfirm,
  onDismiss,
  onRearm,
  onRemove,
  onRecheck,
  busy,
}: {
  job: BlockedDomainJob;
  onConfirm: (id: string) => void | Promise<void>;
  onDismiss: (id: string) => void | Promise<void>;
  onRearm: (id: string) => void | Promise<void>;
  onRemove: (id: string) => void | Promise<void>;
  onRecheck: (id: string, action: "now" | "on" | "off") => void | Promise<void>;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const status = STATUS_META[job.status] ?? STATUS_META.error;
  const active = job.status === "working" || job.status === "deleting";
  const awaiting = job.status === "awaiting_confirmation";

  // Records written by an older build can be missing whole sections; normalise
  // here as well as on the server so an unfamiliar shape degrades to an empty
  // row instead of throwing and blanking the page.
  const errors = job.errors ?? [];
  const sheet = job.sheet;
  const perf = job.performance;
  const domain = perf?.domain;
  const recheck = job.recheck;
  // How many inboxes this run is actually acting on. Records from before the
  // performance check existed acted on every inbox found.
  const stopCount = perf ? perf.inboxes.filter((i) => i.decision === "stop").length : job.inboxesFound;
  // Both halves of the quarantine have to have landed before the card is
  // allowed to say the domain is stopped.
  const fullyStopped = job.sendingStopped === true && job.warmupStopped === true;

  function phaseDetail(phase: (typeof PHASE_ORDER)[number]): string {
    if (phase === "locating") {
      if (job.phaseStates?.locating !== "done") return "";
      if (job.inboxesFound === 0) return "no inboxes found";
      return `${formatNumber(job.inboxesFound)} inbox${
        job.inboxesFound === 1 ? "" : "es"
      } in ${job.workspaceName ?? "a workspace"}${
        job.foundViaSheet ? " (from the sheet)" : ""
      }`;
    }
    if (phase === "assessing") {
      const state = job.phaseStates?.assessing ?? "pending";
      if (state === "pending") return "";
      if (!perf) return state === "skipped" ? "not checked" : "";
      if (perf.source === "skipped") return "check is off — all stopped";
      if (perf.source === "unavailable") return "no figures — all stopped";
      const kept = job.inboxesKept ?? 0;
      const head = domain ? `domain at ${domain.replyRateOoo}% · ` : "";
      const tail = `${formatNumber(stopCount)} under ${perf.threshold}%${kept > 0 ? `, ${formatNumber(kept)} still replying` : ""}`;
      return `${head}${tail}`;
    }
    if (phase === "sheet" && job.status === "kept") return "domain kept — left alone";
    if (phase === "quarantining") {
      if (job.phaseStates?.quarantining === "skipped") return "nothing to stop";
      if (job.phaseStates?.quarantining === "pending") return "";
      if (fullyStopped) return `${formatNumber(stopCount)} stopped`;
      const done = [
        job.sendingStopped ? "sending" : null,
        job.warmupStopped ? "warmup" : null,
      ].filter(Boolean);
      return done.length > 0 ? `only ${done.join(" + ")} stopped` : "";
    }
    if (phase === "sheet") {
      if (!sheet) return "";
      const bits: string[] = [];
      if (sheet.statusUpdated) bits.push("Not Active");
      if (sheet.tenantQueued) bits.push("tenant queued");
      else if (sheet.tenantAlreadyQueued) bits.push("tenant already queued");
      return bits.join(" · ");
    }
    if (awaiting) return "waiting for you";
    return job.inboxesDeleted > 0
      ? `${formatNumber(job.inboxesDeleted)} deleted`
      : "";
  }

  return (
    <div
      className={`pv-card p-4 sm:p-5 ${
        awaiting ? "border-warning/40" : ""
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${status.className}`}
          >
            {active && <Spinner size={10} />} {status.label}
          </span>
          <span className="truncate font-mono text-sm font-medium">
            {job.domain}
          </span>
          {job.autoDeleted && (
            <span className="pv-chip shrink-0">auto-deleted</span>
          )}
          {job.rearmedAt && (
            <span
              className="pv-chip shrink-0"
              title="This domain was allowed to run again; this record is kept as history"
            >
              re-armed
            </span>
          )}
          {job.duplicateHits > 0 && (
            <span
              className="pv-chip shrink-0"
              title={`${job.duplicateHits} later bounce row(s) for this domain hit the webhook and were told it had already run`}
            >
              +{job.duplicateHits} repeat
              {job.duplicateHits === 1 ? "" : "s"} ignored
            </span>
          )}
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          {relativeTime(job.createdAt)}
        </span>
      </div>

      <ol className="mt-4 space-y-2.5">
        {PHASE_ORDER.map((phase, i) => {
          const state = job.phaseStates?.[phase] ?? "pending";
          const detail = phaseDetail(phase);
          return (
            <li key={phase} className="flex gap-3">
              <StepBullet index={i + 1} state={state} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span
                    className={`text-sm ${
                      state === "pending" ? "text-muted-foreground" : ""
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

      {awaiting && (
        <div
          className={`mt-3 rounded-xl border p-3 text-xs ${
            fullyStopped
              ? "border-warning/30 bg-warning/5"
              : "border-danger/40 bg-danger/5"
          }`}
        >
          {/* Never claim more than actually happened: someone reads this line
              and decides whether to go and check Plusvibe themselves. */}
          <p
            className={`font-medium ${
              fullyStopped ? "text-warning" : "text-danger"
            }`}
          >
            {fullyStopped
              ? "Sending and warmup are already stopped"
              : job.sendingStopped
                ? "Sending is stopped — but warmup is NOT"
                : job.warmupStopped
                  ? "Warmup is stopped — but sending is NOT"
                  : "These inboxes are still sending"}
          </p>
          <p className="mt-1 text-muted-foreground">
            {formatNumber(stopCount)} inbox
            {stopCount === 1 ? "" : "es"} on{" "}
            <span className="font-mono">{job.domain}</span> in{" "}
            {job.workspaceName ?? "this workspace"}
            {(job.inboxesKept ?? 0) > 0 && (
              <>
                {" "}
                ({formatNumber(job.inboxesKept ?? 0)} more{" "}
                {(job.inboxesKept ?? 0) === 1 ? "is" : "are"} still replying and will be left alone)
              </>
            )}
            {fullyStopped ? (
              <>
                {" "}
                have their daily limit at 0 and warmup off, so nothing is going
                out. Deleting them cannot be undone.
              </>
            ) : (
              <>
                {" "}
                could not be fully stopped, so they may still be sending. Fix
                that first, or delete them now — deleting cannot be undone.
              </>
            )}
          </p>
        </div>
      )}

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
          Interrupted by a server restart. Whatever was stopped or deleted has
          stuck — check the domain in Plusvibe before re-triggering it.
        </p>
      )}

      {job.status === "kept" && (
        <div className="mt-3 rounded-xl border border-success/30 bg-success/5 p-3 text-xs">
          <p className="font-medium text-success">
            The domain was not written off
            {stopCount > 0 &&
              ` — but ${formatNumber(stopCount)} of its inboxes ${stopCount === 1 ? "was" : "were"} stopped`}
          </p>
          <p className="mt-1 text-muted-foreground">
            Over the last 7 days <span className="font-mono">{job.domain}</span> replied at{" "}
            <span className="font-medium text-foreground">{domain?.replyRateOoo ?? 0}% with OOO</span>
            {domain?.basis === "counts" && (
              <>
                {" "}
                ({formatNumber(domain.replies + domain.oooReplies)} replies from{" "}
                {formatNumber(domain.contacted)} leads contacted)
              </>
            )}
            , at or above the {perf?.domainThreshold ?? 1.5}% domain bar. The Domains tab keeps its status, the tenant
            was not queued to cancel, and nothing was deleted.{" "}
            {stopCount > 0
              ? `The ${formatNumber(stopCount)} inbox${stopCount === 1 ? "" : "es"} under the ${perf?.threshold ?? 1}% inbox bar had their daily limit set to 0 and warmup switched off; turn them back on in Plusvibe if you disagree.`
              : "Every inbox on it is above the inbox bar too, so none were stopped."}
          </p>
        </div>
      )}

      {job.status === "dismissed" && (
        <p className="mt-2 text-xs text-muted-foreground">
          Not deleted. The inboxes are still quarantined — turn their daily
          limit and warmup back on in Plusvibe if you want them sending again.
        </p>
      )}

      {recheck && (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <ClockIcon size={13} />
            {recheck.enabled
              ? `Checked again every ${recheck.everyDays} days · next ${describeNext(recheck.nextAt, Date.now())}`
              : recheck.endedReason || "Not being checked again"}
          </span>
          {recheck.runs.length > 0 && (
            <button type="button" className="underline" onClick={() => setOpen((v) => !v)}>
              {recheck.runs.length} repeat check{recheck.runs.length === 1 ? "" : "s"} so far
            </button>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {awaiting && (
          <>
            <button
              type="button"
              className="pv-btn-primary disabled:opacity-50"
              disabled={busy}
              onClick={() => onConfirm(job.id)}
            >
              {busy ? <Spinner /> : <TrashIcon size={16} />}
              Delete {formatNumber(stopCount)} inbox
              {stopCount === 1 ? "" : "es"}
            </button>
            <button
              type="button"
              className="pv-btn-ghost"
              disabled={busy}
              onClick={() => onDismiss(job.id)}
            >
              Keep them
            </button>
          </>
        )}

        {/* Re-arming keeps the run in the history and only lifts the
            once-per-domain guard. Deleting the record is the separate,
            destructive option. */}
        {!active && !awaiting && !job.rearmedAt && (
          <button
            type="button"
            className="pv-btn-ghost disabled:opacity-50"
            disabled={busy}
            onClick={() => onRearm(job.id)}
            title={`Let ${job.domain} trigger again. This run stays in the history.`}
          >
            <RefreshIcon size={16} />
            Allow re-run
          </button>
        )}

        {!active && recheck && (
          <>
            <button
              type="button"
              className="pv-btn-ghost disabled:opacity-50"
              disabled={busy}
              onClick={() => onRecheck(job.id, "now")}
              title="Read the last 7 days again now, and act on what it says"
            >
              {busy ? <Spinner /> : <GaugeIcon size={16} />}
              Check now
            </button>
            <button
              type="button"
              className="pv-btn-ghost disabled:opacity-50"
              disabled={busy}
              onClick={() => onRecheck(job.id, recheck.enabled ? "off" : "on")}
            >
              {recheck.enabled ? "Stop watching" : "Watch again"}
            </button>
          </>
        )}

        {/* Available on every card, including one waiting for confirmation —
            a job that can't be confirmed or dismissed would otherwise be
            stuck there forever. */}
        {!active && <RemoveJobButton onRemove={() => onRemove(job.id)} />}

        <button
          type="button"
          className="pv-btn-ghost"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide details" : "Details"}
        </button>
      </div>

      {open && (
        <div className="mt-3 space-y-2 rounded-xl border border-border p-3 text-xs">
          <Detail label="Domain" value={job.domain} />
          <Detail
            label="Workspace"
            value={
              job.workspaceName
                ? `${job.workspaceName}${
                    job.foundViaSheet
                      ? " — matched from the sheet's Client column"
                      : ` — found by scanning ${formatNumber(job.workspacesScanned ?? 0)} workspace(s)`
                  }`
                : "not found"
            }
          />
          <Detail
            label="Inboxes"
            value={`${formatNumber(job.inboxesFound)} found · ${formatNumber(
              job.inboxesQuarantined
            )} stopped · ${formatNumber(job.inboxesKept ?? 0)} left sending · ${formatNumber(job.inboxesDeleted)} deleted`}
          />
          {perf && (
            <>
              {domain && domain.basis !== "none" && (
                <Detail
                  label="Domain over 7 days"
                  value={`${domain.replyRateOoo}% with OOO · ${domain.replyRate}% plain${
                    domain.basis === "counts"
                      ? ` · ${formatNumber(domain.replies)} replies + ${formatNumber(domain.oooReplies)} OOO from ${formatNumber(domain.contacted)} contacted · ${formatNumber(domain.sent)} sent`
                      : ` · averaged across ${formatNumber(domain.inboxes)} inboxes by send volume`
                  } — ${
                    domain.verdict === "performing"
                      ? `at or above the ${perf?.domainThreshold ?? 1.5}% domain bar, so the domain and tenant were left alone`
                      : `under the ${perf?.domainThreshold ?? 1.5}% domain bar, so the domain was written off`
                  }`}
                />
              )}
              <Detail
                label="Last 7 days"
                value={
                  perf.source === "skipped"
                    ? `check off — every inbox stopped (${perf.start} … ${perf.end})`
                    : perf.source === "unavailable"
                      ? `no figures available — every inbox stopped (${perf.start} … ${perf.end})`
                      : `${perf.start} … ${perf.end} · keep at ${perf.threshold}%+ reply rate with OOO`
                }
              />
              {perf.inboxes.length > 0 && (
                <div className="space-y-1 pt-1">
                  {perf.inboxes.map((i) => (
                    <div key={i.id || i.email} className="flex flex-wrap items-baseline gap-x-2">
                      <span
                        className={`rounded-full px-1.5 py-0.5 text-[11px] ${
                          i.decision === "keep"
                            ? "bg-success/10 text-success"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {i.decision === "keep" ? "kept" : "stopped"}
                      </span>
                      <span className="break-all font-mono">{i.email}</span>
                      {/* The reason is always shown: an inbox stopped for
                          sending nothing reads as "0%", which looks like a
                          judgement on its copy rather than on its silence. */}
                      <span className="text-muted-foreground">
                        {REASON_LABELS[i.reason]}
                        {i.replyRateOoo !== undefined &&
                          ` · ${i.replyRateOoo}% with OOO · ${i.replyRate}% plain · ${formatNumber(i.sent ?? 0)} sent`}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
          {job.bounceReason && (
            <Detail label="Bounce reason" value={job.bounceReason} />
          )}
          <Detail label="Triggered by" value={job.source} />
          {recheck && recheck.runs.length > 0 && (
            <div className="space-y-1 pt-1">
              <span className="text-muted-foreground">Repeat checks:</span>
              {recheck.runs.map((r, i) => (
                <div key={`${r.at}-${i}`} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-muted-foreground">{relativeTime(r.at)}</span>
                  <span>
                    {r.error
                      ? r.error
                      : `${formatNumber(r.inboxesFound)} inbox${r.inboxesFound === 1 ? "" : "es"}${
                          r.domainReplyRateOoo !== undefined ? ` · domain at ${r.domainReplyRateOoo}%` : ""
                        } · ${r.stopped > 0 ? `${formatNumber(r.stopped)} newly stopped` : "nothing new to stop"}${
                          r.kept > 0 ? `, ${formatNumber(r.kept)} still replying` : ""
                        }${r.wroteOff ? " · domain written off" : ""}`}
                  </span>
                  {r.trigger === "manual" && <span className="text-muted-foreground">(by hand)</span>}
                </div>
              ))}
            </div>
          )}
          {sheet && (
            <>
              <Detail
                label="Domains tab"
                value={
                  sheet.statusUpdated
                    ? `row ${sheet.domainRow} · ${sheet.previousStatus || "(blank)"} → Not Active`
                    : sheet.error || "not updated"
                }
              />
              <Detail
                label="Tenant"
                value={
                  sheet.tenantEmail
                    ? `${sheet.tenantEmail}${sheet.tenantSource ? ` · ${sheet.tenantSource}` : ""} — ${
                        sheet.tenantQueued
                          ? "queued to cancel"
                          : sheet.tenantAlreadyQueued
                            ? "already on the cancel list"
                            : "not queued"
                      }`
                    : "none in the sheet"
                }
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function StepBullet({ index, state }: { index: number; state: PhaseState }) {
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
  if (state === "waiting") {
    return (
      <span
        className={`${base} bg-warning/15 text-warning`}
        title="Waiting for confirmation"
      >
        !
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
  if (state === "running") {
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

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap gap-x-2">
      <span className="shrink-0 text-muted-foreground">{label}:</span>
      <span className="break-all">{value}</span>
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
