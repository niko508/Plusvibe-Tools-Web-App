"use client";

import { useEffect, useState } from "react";
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
import { normalizeLimit } from "@/lib/blocked-domains/rejudge";
import { bucketOf, describeProviders, PROVIDER_LABELS } from "@/lib/plusvibe-providers";
import { GOOGLE_CANCEL_TAB } from "@/lib/blocked-domains/sheet-plan";

const STATUS_META: Record<
  BlockedDomainStatus,
  { label: string; className: string }
> = {
  working: { label: "Working", className: "bg-accent/10 text-accent" },
  kept: { label: "Domain kept — still sending", className: "bg-success/10 text-success" },
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
  onRejudge,
  onRestore,
  onUndoWriteOff,
  busy,
}: {
  job: BlockedDomainJob;
  onConfirm: (id: string) => void | Promise<void>;
  onDismiss: (id: string) => void | Promise<void>;
  onRearm: (id: string) => void | Promise<void>;
  onRemove: (id: string) => void | Promise<void>;
  onRecheck: (id: string, action: "now" | "on" | "off") => void | Promise<void>;
  onRejudge: (id: string) => void | Promise<void>;
  onRestore: (id: string, dailyLimit: number) => void | Promise<void>;
  onUndoWriteOff: (id: string) => void | Promise<void>;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rj = job.rejudge;
  // The limit to restore at: prefilled from what the workspace's sending
  // inboxes use, editable, and re-seeded whenever a new re-judgement lands.
  const [limit, setLimit] = useState(String(rj?.suggestedLimit ?? 30));
  useEffect(() => {
    if (rj?.suggestedLimit !== undefined) setLimit(String(rj.suggestedLimit));
  }, [rj?.at, rj?.suggestedLimit]);
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
  const host = sheet?.domainHost;
  // Records from before the provider was captured have no counts; the chip is
  // left off rather than claiming a domain had no mailboxes.
  const providerMix = job.providers ? describeProviders(job.providers) : "";
  // "12/50 sending" — how much of the domain is still going out. Records from
  // before this was tracked carry no count, so it is derived from what they do
  // record: everything found, minus what this run stopped. Falling back to the
  // total would claim a fully-stopped domain is still sending.
  const activeCount = job.inboxesActive ?? Math.max(0, job.inboxesFound - job.inboxesQuarantined);
  const sendingLabel = `${formatNumber(activeCount)}/${formatNumber(job.inboxesFound)} sending`;
  // How many inboxes this run is actually acting on: the quarantined list is
  // kept current by every run, repeat check and restore, so it is what a
  // Delete would take. Records from before it was kept fall back to the
  // assessment, and before that to every inbox found.
  const stopCount = job.quarantinedEmails
    ? job.quarantinedEmails.length
    : perf
      ? perf.inboxes.filter((i) => i.decision === "stop").length
      : job.inboxesFound;
  // Both halves of the quarantine have to have landed before the card is
  // allowed to say the domain is stopped.
  const fullyStopped = job.sendingStopped === true && job.warmupStopped === true;

  function phaseDetail(phase: (typeof PHASE_ORDER)[number]): string {
    if (phase === "locating") {
      if (job.phaseStates?.locating !== "done") return "";
      if (job.inboxesFound === 0) return "no inboxes found";
      return `${sendingLabel} in ${job.workspaceName ?? "a workspace"}${
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
      const tail = `${formatNumber(stopCount)} under ${perf.threshold}%${kept > 0 ? `, ${formatNumber(kept)} still sending` : ""}`;
      return `${head}${tail}`;
    }
    if (phase === "sheet" && sheet?.googlePath) {
      const bits: string[] = [];
      if (sheet.statusUpdated) bits.push("Not Active");
      const n = sheet.googleQueued?.length ?? 0;
      if (n > 0) bits.push(`${formatNumber(n)} inbox${n === 1 ? "" : "es"} listed to cancel`);
      if (bits.length === 0 && job.status === "kept") return "domain kept — left alone";
      return bits.join(" · ");
    }
    if (phase === "sheet" && sheet?.revertedTo !== undefined) {
      return `Not Active, then put back to ${sheet.revertedTo || "(blank)"}`;
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
          {job.workspaceName && (
            <span className="pv-chip shrink-0" title="Workspace">
              {job.workspaceName}
            </span>
          )}
          {host && (
            <span className="pv-chip shrink-0" title="Domain Host, from the Domains sheet">
              {host}
            </span>
          )}
          {providerMix && (
            <span
              className="pv-chip shrink-0"
              title="The mailboxes this domain was running on, as Plusvibe reports them"
            >
              {providerMix}
            </span>
          )}
          {job.inboxesFound > 0 && (
            <span
              className={`pv-chip shrink-0 ${activeCount === 0 ? "text-muted-foreground" : ""}`}
              title="Inboxes on this domain still sending, out of the total"
            >
              {sendingLabel}
            </span>
          )}
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
                {(job.inboxesKept ?? 0) === 1 ? "is" : "are"} still sending and will be left alone)
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
          {sheet?.revertedTo !== undefined && rj ? (
            // Kept by a person after re-judging, not by the run: the figure
            // that justifies it is the re-judgement's, not the original one.
            <p className="mt-1 text-muted-foreground">
              Written off by the run, then put back after re-judging: over{" "}
              {rj.start} … {rj.end} <span className="font-mono">{job.domain}</span> stood at{" "}
              <span className="font-medium text-foreground">{rj.domain.replyRateOoo}% with OOO</span>
              {rj.domain.basis === "counts" &&
                ` (${formatNumber(rj.domain.replies + rj.domain.oooReplies)} replies from ${formatNumber(rj.domain.contacted)} leads contacted)`}
              . The Domains row is back to {sheet.revertedTo || "blank"} and the domain is watched again.
              {sheet.manualCleanup && ` ${sheet.manualCleanup}`}
            </p>
          ) : (
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
            {sheet?.googlePath ? (
              <>
                . It runs on Google Workspace, so there is no tenant to cancel: the Domains tab
                keeps its status until every inbox on it is burned, and nothing was deleted.{" "}
              </>
            ) : (
              <>
                , at or above the {perf?.domainThreshold ?? 1.5}% domain bar. The Domains tab keeps its status, the tenant
                was not queued to cancel, and nothing was deleted.{" "}
              </>
            )}
            {stopCount > 0
              ? `The ${formatNumber(stopCount)} inbox${stopCount === 1 ? "" : "es"} under the ${perf?.threshold ?? 1}% inbox bar had their daily limit set to 0 and warmup switched off${
                  sheet?.googlePath && (sheet.googleQueued?.length ?? 0) > 0
                    ? `, and ${formatNumber(sheet.googleQueued!.length)} ${sheet.googleQueued!.length === 1 ? "was" : "were"} added to "${GOOGLE_CANCEL_TAB}"`
                    : ""
                }; turn them back on in Plusvibe if you disagree.`
              : "Every inbox on it is above the inbox bar too, so none were stopped."}
          </p>
          )}
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

      {rj && (
        <div className="mt-3 rounded-xl border border-accent/30 bg-accent/5 p-3 text-xs" data-rejudge>
          <p className="font-medium">
            Re-judged on the current rules over {rj.start} … {rj.end}
          </p>
          <p className="mt-1 text-muted-foreground">
            Domain at{" "}
            <span className="font-medium text-foreground">{rj.domain.replyRateOoo}% with OOO</span>
            {rj.domain.basis === "counts" &&
              ` (${formatNumber(rj.domain.replies + rj.domain.oooReplies)} replies from ${formatNumber(rj.domain.contacted)} contacted)`}
            {" — "}
            {rj.googlePath
              ? rj.wouldWriteOff
                ? "every inbox is burned, so it would be written off."
                : `${formatNumber(rj.inboxes.length - rj.stillUnder.length)} of ${formatNumber(rj.inboxes.length)} inboxes clear the ${rj.threshold}% bar, so it would be kept.`
              : rj.wouldWriteOff
                ? `under the ${rj.domainThreshold}% domain bar, so it would be written off.`
                : `at or above the ${rj.domainThreshold}% domain bar, so it would be kept.`}{" "}
            {rj.restorable.length > 0
              ? `${formatNumber(rj.restorable.length)} of the inboxes this automation stopped clear${rj.restorable.length === 1 ? "s" : ""} the ${rj.threshold}% inbox bar on this window and can be turned back on.`
              : "None of the inboxes this automation stopped clears the inbox bar on this window."}
            {rj.stillUnder.length > 0 &&
              ` ${formatNumber(rj.stillUnder.length)} ${rj.stillUnder.length === 1 ? "is" : "are"} under it.`}
          </p>
          {rj.source === "unavailable" && (
            <p className="mt-1 text-warning">
              No figures came back for this window, so nothing here should be acted on.
            </p>
          )}
          {rj.restorable.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="pv-btn-primary disabled:opacity-50"
                disabled={busy || normalizeLimit(limit) === null}
                onClick={() => onRestore(job.id, Number(limit))}
                title="Daily limit back up and warmup on, for these inboxes only"
              >
                {busy ? <Spinner /> : <RefreshIcon size={16} />}
                Restore {formatNumber(rj.restorable.length)} inbox{rj.restorable.length === 1 ? "" : "es"}
              </button>
              <label className="flex items-center gap-1.5 text-muted-foreground">
                at
                <input
                  type="number"
                  className="pv-input w-20 py-1 text-xs"
                  min={1}
                  max={500}
                  step={1}
                  value={limit}
                  onChange={(e) => setLimit(e.target.value)}
                  aria-label="Daily limit to restore to"
                />
                a day
              </label>
            </div>
          )}
          {sheet?.statusUpdated && !rj.wouldWriteOff && (
            <div className="mt-2">
              <button
                type="button"
                className="pv-btn-ghost disabled:opacity-50"
                disabled={busy}
                onClick={() => onUndoWriteOff(job.id)}
                title="Put the Domains row's Status back to what it was, and keep the domain"
              >
                Undo write-off
              </button>
            </div>
          )}
          {sheet?.manualCleanup && <p className="mt-2 text-warning">{sheet.manualCleanup}</p>}
          {job.restores?.[0] && (
            <p className="mt-2 text-muted-foreground">
              Restored {formatNumber(job.restores[0].emails.length)} at {job.restores[0].dailyLimit} a day{" "}
              {relativeTime(job.restores[0].at)}: {job.restores[0].emails.join(", ")}
              {job.restores[0].error && ` — ${job.restores[0].error}`}
            </p>
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

        {!active && (
          <button
            type="button"
            className="pv-btn-ghost disabled:opacity-50"
            disabled={busy}
            onClick={() => onRejudge(job.id)}
            title="Read a wider window — back to before it was flagged — and judge it on the current rules. Changes nothing by itself."
          >
            {busy ? <Spinner /> : <GaugeIcon size={16} />}
            Re-judge
          </button>
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
            value={`${sendingLabel} · ${formatNumber(job.inboxesQuarantined)} stopped by this run · ${formatNumber(
              job.inboxesKept ?? 0
            )} above the inbox bar · ${formatNumber(job.inboxesDeleted)} deleted`}
          />
          {host && <Detail label="Domain host" value={`${host} — from the Domains sheet`} />}
          {providerMix && <Detail label="Mailboxes" value={providerMix} />}
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
                      {i.provider && (
                        <span className="text-muted-foreground/70">
                          {PROVIDER_LABELS[bucketOf(i.provider)]}
                        </span>
                      )}
                      {/* The reason is always shown: an inbox stopped for
                          sending nothing reads as "0%", which looks like a
                          judgement on its copy rather than on its silence. */}
                      <span className="text-muted-foreground">
                        {REASON_LABELS[i.reason]}
                        {i.replyRateOoo !== undefined &&
                          ` · ${i.replyRateOoo}% with OOO · ${i.replyRate}% plain${
                            i.contacted
                              ? ` · ${formatNumber((i.replies ?? 0) + (i.oooReplies ?? 0))} from ${formatNumber(i.contacted)} contacted`
                              : ""
                          } · ${formatNumber(i.sent ?? 0)} sent`}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
          {rj && rj.inboxes.length > 0 && (
            <div className="space-y-1 pt-1">
              <span className="text-muted-foreground">
                Re-judged over {rj.start} … {rj.end}, at {rj.threshold}%+ with OOO:
              </span>
              {rj.inboxes.map((i) => (
                <div key={`rj-${i.id || i.email}`} className="flex flex-wrap items-baseline gap-x-2">
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[11px] ${
                      i.decision === "keep" ? "bg-success/10 text-success" : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {i.decision === "keep" ? "clears the bar" : "under the bar"}
                  </span>
                  <span className="break-all font-mono">{i.email}</span>
                  <span className="text-muted-foreground">
                    {i.stoppedByUs ? "stopped by this automation" : i.sendingNow ? "sending" : "stopped, not by this automation"}
                    {i.replyRateOoo !== undefined &&
                      ` · ${i.replyRateOoo}% with OOO${
                        i.contacted ? ` · ${formatNumber((i.replies ?? 0) + (i.oooReplies ?? 0))} from ${formatNumber(i.contacted)} contacted` : ""
                      } · ${formatNumber(i.sent ?? 0)} sent`}
                  </span>
                </div>
              ))}
            </div>
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
                          r.kept > 0 ? `, ${formatNumber(r.kept)} still sending` : ""
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
                    : sheet.revertedTo !== undefined
                      ? `row ${sheet.domainRow} · Not Active → ${sheet.revertedTo || "(blank)"} (put back ${relativeTime(sheet.revertedAt ?? 0)})`
                    : sheet.error ||
                      (sheet.googlePath && job.status === "kept"
                        ? "left alone — Not Active once every inbox is burned"
                        : "not updated")
                }
              />
              {sheet.googlePath && (
                <Detail
                  label="Google inboxes"
                  value={
                    (sheet.googleQueued?.length ?? 0) > 0
                      ? `${formatNumber(sheet.googleQueued!.length)} listed on "${GOOGLE_CANCEL_TAB}": ${sheet.googleQueued!.join(", ")}${
                          (sheet.googleAlreadyQueued?.length ?? 0) > 0
                            ? ` · ${formatNumber(sheet.googleAlreadyQueued!.length)} already there`
                            : ""
                        }`
                      : (sheet.googleAlreadyQueued?.length ?? 0) > 0
                        ? `all ${formatNumber(sheet.googleAlreadyQueued!.length)} burned inboxes were already on "${GOOGLE_CANCEL_TAB}"`
                        : "none burned, so none listed"
                  }
                />
              )}
              <Detail
                label="Tenant"
                value={
                  sheet.googlePath
                    ? "Google Workspace — no tenant to cancel; the inboxes are listed instead"
                    : sheet.tenantEmail
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
