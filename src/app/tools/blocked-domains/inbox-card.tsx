"use client";

// One sender inbox Clay sent: what its last 14 days said, the rule it was
// judged on, and what was done about it.

import type { BlockedInboxJob, BlockedInboxStatus } from "@/lib/jobs/blocked-inboxes-types";
import { platformKey, UNKNOWN_PLATFORM } from "@/lib/blocked-inboxes/domains";
import { PROVIDER_LABELS } from "@/lib/plusvibe-providers";
import { formatNumber } from "@/lib/format";
import { Spinner } from "@/components/ui";
import { AlertIcon, TrashIcon } from "@/components/icons";

export const INBOX_STATUS: Record<BlockedInboxStatus, { label: string; className: string }> = {
  queued: { label: "In line", className: "bg-muted text-muted-foreground" },
  working: { label: "Checking", className: "bg-accent/10 text-accent" },
  passed: { label: "Passed", className: "bg-success/10 text-success" },
  untouched: { label: "Left alone", className: "bg-muted text-muted-foreground" },
  not_found: { label: "Not found", className: "bg-muted text-muted-foreground" },
  awaiting_confirmation: { label: "Blocked — waiting for you", className: "bg-warning/10 text-warning" },
  deleting: { label: "Deleting", className: "bg-accent/10 text-accent" },
  deleted: { label: "Blocked — deleted", className: "bg-danger/10 text-danger" },
  dismissed: { label: "Blocked — kept stopped", className: "bg-muted text-muted-foreground" },
  error: { label: "Error", className: "bg-danger/10 text-danger" },
  interrupted: { label: "Interrupted", className: "bg-warning/10 text-warning" },
};

export function InboxCard({
  job,
  busy,
  onConfirm,
  onDismiss,
  onRemove,
}: {
  job: BlockedInboxJob;
  busy: boolean;
  onConfirm: (id: string) => void;
  onDismiss: (id: string) => void;
  /** Absent where there is no Home to remove it from. */
  onRemove?: (id: string) => void;
}) {
  const status = INBOX_STATUS[job.status] ?? INBOX_STATUS.error;
  const platform = platformKey(job.domainHost, job.registrar);
  const f = job.figures;
  const r = job.rates;
  const active = job.status === "working" || job.status === "deleting";

  return (
    <div className="pv-card p-4 sm:p-5" data-inbox-job={job.email}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${status.className}`} data-status={job.status}>
            {active && <Spinner size={10} />} {status.label}
          </span>
          <span className="truncate font-mono text-sm font-medium">{job.email}</span>
          {job.workspaceName && <span className="pv-chip shrink-0" title="Workspace">{job.workspaceName}</span>}
          {job.provider && <span className="pv-chip shrink-0" title="Mailbox provider">{PROVIDER_LABELS[job.provider]}</span>}
          {platform !== UNKNOWN_PLATFORM && (
            <span className="pv-chip shrink-0" title={job.domainHost ? "Domain Host, from the Domains sheet" : `Registrar: ${job.registrar}`}>
              {platform}
            </span>
          )}
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(job.judgedAt ?? job.createdAt)}</span>
      </div>

      {f && r && (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4" data-figures>
          <Figure label={`Sent · last 14 days`} value={formatNumber(f.sent)} sub={job.tier ?? ""} />
          <Figure label="Bounce rate" value={`${r.bounceRate}%`} sub={`${formatNumber(f.bounces)} bounced of ${formatNumber(f.sent)} sent`} />
          <Figure label="Human reply rate" value={`${r.humanReplyRate}%`} sub={`${formatNumber(f.replies)} of ${formatNumber(f.contacted)} contacted`} />
          <Figure label="OOO reply rate" value={`${r.oooReplyRate}%`} sub={`${formatNumber(f.replies + f.oooReplies)} incl. out-of-office`} />
        </div>
      )}

      {job.rule && (
        <p className="mt-2 text-xs text-muted-foreground" data-rule>
          Rule for {PROVIDER_LABELS[job.provider ?? "other"]} at {job.tier}: blocked when {job.rule}.
        </p>
      )}
      {job.reasons && job.reasons.length > 0 && (
        <p className="mt-1 text-xs text-danger" data-reasons>
          Blocked: {job.reasons.join("; ")}.
        </p>
      )}
      {job.overruled && (
        <p className="mt-1 text-xs text-success" data-overruled>
          Kept: {job.overruled}.
        </p>
      )}
      {job.status === "untouched" && (
        <p className="mt-1 text-xs text-muted-foreground">Neither Microsoft nor Google, so it is left alone.</p>
      )}

      {job.blockedAt !== undefined && (
        <p className="mt-2 text-xs text-muted-foreground" data-actions-taken>
          {job.sendingStopped && job.warmupStopped
            ? "Sending and warmup stopped."
            : job.sendingStopped
              ? "Sending stopped; warmup could not be switched off."
              : "Could not stop it sending — check it in Plusvibe."}
          {job.provider === "google" &&
            (job.googleCancel?.listed
              ? " Listed on 🛑 Google Inboxes to Cancel."
              : job.googleCancel?.error
                ? ` Not listed on 🛑 Google Inboxes to Cancel: ${job.googleCancel.error}`
                : "")}
          {job.lastOnDomain && ` It was the last inbox on ${job.domain}, so the domain was set Not Active.`}
          {job.cancelledWithDomain && (job.tier === "tenant blocked" ? ` Stopped when ${job.domain} was tenant blocked.` : ` Stopped when ${job.domain} was cancelled.`)}
          {job.status === "deleted" && ` Deleted${job.autoDeleted ? " automatically" : ""}.`}
          {job.status === "awaiting_confirmation" && " The deletion waits for you."}
          {job.status === "dismissed" && " You chose to keep it; it stays stopped."}
        </p>
      )}

      {job.duplicateHits > 0 && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          Clay sent it {formatNumber(job.duplicateHits)} more time{job.duplicateHits === 1 ? "" : "s"} since.
        </p>
      )}
      {job.history && job.history.length > 0 && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          Judged before: {job.history.map((h) => `${h.verdict} at ${h.sent} sent, ${h.bounceRate}% bounce`).join(" · ")}
        </p>
      )}

      {job.errors.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs text-warning">
          {job.errors.map((e, i) => (
            <li key={i} className="flex gap-1.5">
              <AlertIcon size={13} className="mt-0.5 shrink-0" /> {e}
            </li>
          ))}
        </ul>
      )}

      {!active && (
        <div className="mt-3 flex flex-wrap gap-2">
          {job.status === "awaiting_confirmation" && (
            <>
              <button type="button" className="pv-btn-ghost text-danger disabled:opacity-50" data-confirm disabled={busy} onClick={() => onConfirm(job.id)}>
                {busy ? <Spinner size={14} /> : <TrashIcon size={14} />} Delete inbox
              </button>
              <button type="button" className="pv-btn-ghost disabled:opacity-50" data-dismiss disabled={busy} onClick={() => onDismiss(job.id)}>
                Keep it stopped
              </button>
            </>
          )}
          {onRemove && job.status !== "awaiting_confirmation" && (
            <button
              type="button"
              className="pv-btn-ghost disabled:opacity-50"
              data-remove
              disabled={busy}
              onClick={() => onRemove(job.id)}
              title={
                job.blockedAt !== undefined
                  ? "Take it off Home. It stays on Blocked Inboxes and Blocked Domains."
                  : job.status === "queued"
                    ? "Take it out of line; it won't be checked."
                    : "Take it off Home; the next bounce from this inbox is judged afresh."
              }
            >
              {job.status === "queued" ? "Take out of line" : "Remove"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Figure({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-xl border border-border px-3 py-2">
      <div className="truncate text-[11px] text-muted-foreground">{label}</div>
      <div className="text-base font-semibold tabular-nums">{value}</div>
      <div className="truncate text-[11px] text-muted-foreground">{sub}</div>
    </div>
  );
}

export function relativeTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
