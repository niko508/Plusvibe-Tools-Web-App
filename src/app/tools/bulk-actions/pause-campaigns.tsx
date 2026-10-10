"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Workspace } from "@/lib/plusvibe-types";
import type {
  PauseCampaignsJob,
  PausePlan,
} from "@/lib/jobs/pause-campaigns-types";
import { validateResumeAt } from "@/lib/pause-campaigns/plan";
import {
  planPauseCampaigns,
  startPauseCampaigns,
  listPauseCampaignsJobs,
  abortPauseCampaigns,
  deletePauseCampaignsJob,
  resumePauseCampaignsNow,
  cancelPauseCampaignsResume,
  ApiClientError,
} from "@/lib/api-client";
import { formatNumber } from "@/lib/format";
import { Spinner, RemoveJobButton } from "@/components/ui";
import {
  AlertIcon,
  CheckIcon,
  ClockIcon,
  PauseIcon,
  PlayIcon,
  RefreshIcon,
} from "@/components/icons";

// Pauses every active campaign in the selected workspaces, and continues
// exactly those — at a chosen date, or by hand.
//
// The continue is the part worth being careful about. It runs on the server
// whether or not this tab is open, it only ever touches the campaigns this job
// paused, and after a server restart it needs a key — the panel says which of
// those is true right now rather than leaving it to be discovered on the day.

const POLL_ACTIVE_MS = 4000;
const POLL_WAITING_MS = 30000;

export function PauseCampaigns({
  workspaces,
  selected,
  loading,
}: {
  workspaces: Workspace[];
  selected: Set<string>;
  loading: boolean;
}) {
  const [scheduleResume, setScheduleResume] = useState(true);
  const [resumeLocal, setResumeLocal] = useState(() => defaultResumeLocal());
  const [plan, setPlan] = useState<PausePlan | null>(null);
  const [planFor, setPlanFor] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [jobs, setJobs] = useState<PauseCampaignsJob[]>([]);
  const [serverKey, setServerKey] = useState<boolean | null>(null);
  const runLock = useRef(false);

  const chosen = useMemo(
    () =>
      workspaces
        .filter((w) => selected.has(w._id))
        .map((w) => ({ id: w._id, name: w.name })),
    [workspaces, selected]
  );
  const chosenIds = chosen.map((c) => c.id).join(",");

  // datetime-local is read as local time, which is what the person meant.
  const resumeAt = scheduleResume ? new Date(resumeLocal).getTime() : undefined;
  const resumeProblem =
    scheduleResume && resumeAt !== undefined ? validateResumeAt(resumeAt) : null;
  const canRun = chosen.length > 0 && !busy && !resumeProblem;
  const planStale = plan !== null && planFor !== chosenIds;

  const refreshJobs = useCallback(async () => {
    try {
      const view = await listPauseCampaignsJobs();
      setJobs(view.jobs);
      setServerKey(view.readiness.serverKey);
    } catch {
      // polling failure is not worth a banner
    }
  }, []);

  useEffect(() => {
    void refreshJobs();
  }, [refreshJobs]);

  const anyActive = jobs.some((j) => j.status === "running" || j.status === "resuming");
  const anyWaiting = jobs.some((j) => j.resumeAt !== undefined && j.resumedAt === undefined);
  useEffect(() => {
    if (!anyActive && !anyWaiting) return;
    const t = setInterval(
      () => void refreshJobs(),
      anyActive ? POLL_ACTIVE_MS : POLL_WAITING_MS
    );
    return () => clearInterval(t);
  }, [anyActive, anyWaiting, refreshJobs]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  async function preview() {
    if (!canRun || runLock.current) return;
    runLock.current = true;
    setBusy(true);
    setError(null);
    try {
      setPlan(await planPauseCampaigns({ workspaces: chosen, resumeAt }));
      setPlanFor(chosenIds);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      runLock.current = false;
      setBusy(false);
    }
  }

  async function start() {
    if (!canRun || runLock.current) return;
    runLock.current = true;
    setBusy(true);
    setError(null);
    try {
      await startPauseCampaigns({ workspaces: chosen, resumeAt });
      setPlan(null);
      setToast(
        resumeAt !== undefined
          ? `Pausing… they continue ${formatWhen(resumeAt)}.`
          : "Pausing… you can close this tab."
      );
      await refreshJobs();
    } catch (err) {
      setError(errMessage(err));
    } finally {
      runLock.current = false;
      setBusy(false);
    }
  }

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await refreshJobs();
    } catch (err) {
      setError(errMessage(err));
    }
  };

  const totalToPause = plan ? plan.totals.parents + plan.totals.subsequences : null;

  return (
    <div className="space-y-4">
      <div className="pv-card space-y-4 p-4 sm:p-5">
        <div className="rounded-xl border border-border p-3">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={scheduleResume}
              onChange={(e) => setScheduleResume(e.target.checked)}
            />
            <span>
              <span className="font-medium">Continue them automatically</span>
              <span className="block text-xs text-muted-foreground">
                Exactly the campaigns this run pauses — nothing that was already
                paused, drafted or completed.
              </span>
            </span>
          </label>
          {scheduleResume && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <input
                type="datetime-local"
                className="pv-input w-auto text-sm"
                value={resumeLocal}
                onChange={(e) => setResumeLocal(e.target.value)}
              />
              {resumeAt !== undefined && !resumeProblem && (
                <span className="text-xs text-muted-foreground">
                  {formatWhen(resumeAt)} · {timezoneName()} · in {relativeFromNow(resumeAt)}
                </span>
              )}
              {resumeProblem && (
                <span className="flex gap-1.5 text-xs text-warning">
                  <AlertIcon size={13} className="mt-0.5 shrink-0" />
                  {resumeProblem}
                </span>
              )}
            </div>
          )}
          {scheduleResume && serverKey === false && (
            <p className="mt-3 flex gap-1.5 text-xs text-warning">
              <AlertIcon size={13} className="mt-0.5 shrink-0" />
              <span>
                The server has no <span className="font-mono">PLUSVIBE_API_KEY</span>.
                The continue fires on its own only while this app keeps running;
                if it restarts before then (a Railway redeploy does that), the
                job shows as blocked here and you press{" "}
                <span className="font-medium">Continue now</span> instead. Set the
                variable to make the date stick regardless.
              </span>
            </p>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          Every <span className="text-foreground">active</span> campaign in each
          selected workspace is paused, sub-sequences included. Paused, drafted,
          completed and archived campaigns are left exactly as they are.
          Preview first to see the counts.
        </p>

        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger">
            <AlertIcon size={16} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="pv-btn-ghost disabled:opacity-50"
            disabled={!canRun}
            onClick={preview}
          >
            {busy ? <Spinner /> : <RefreshIcon size={16} />}
            Preview
          </button>
          <button
            type="button"
            className="pv-btn-primary disabled:opacity-50"
            disabled={!canRun}
            onClick={start}
          >
            {busy ? <Spinner /> : <PauseIcon size={16} />}
            Pause
            {totalToPause !== null && !planStale
              ? ` ${formatNumber(totalToPause)} campaigns`
              : ""}{" "}
            in {formatNumber(chosen.length)} workspace{chosen.length === 1 ? "" : "s"}
          </button>
          {chosen.length === 0 && !loading && (
            <span className="text-xs text-muted-foreground">
              Pick some workspaces above first.
            </span>
          )}
        </div>

        {plan && (
          <div className="rounded-xl border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-semibold">
                Preview
                <span className="ml-1.5 font-normal text-muted-foreground">
                  · {formatNumber(plan.totals.parents)} campaign
                  {plan.totals.parents === 1 ? "" : "s"} +{" "}
                  {formatNumber(plan.totals.subsequences)} sub-sequence
                  {plan.totals.subsequences === 1 ? "" : "s"} would be paused ·{" "}
                  {formatNumber(plan.totals.skipped)} left alone
                </span>
              </span>
              <span className="text-xs text-muted-foreground">Nothing has been paused yet.</span>
            </div>
            {planStale && (
              <p className="mt-2 flex gap-1.5 text-xs text-warning">
                <AlertIcon size={13} className="mt-0.5 shrink-0" />
                The workspace selection changed since this preview, so it no
                longer describes what would happen.
              </p>
            )}
            <div className="pv-scroll mt-2 max-h-64 overflow-y-auto rounded-lg border border-border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Workspace</th>
                    <th className="px-3 py-2 font-medium">Would pause</th>
                    <th className="px-3 py-2 font-medium">Left alone</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.workspaces.map((w) => (
                    <tr key={w.workspaceId} className="border-b border-border/70 last:border-0">
                      <td className="px-3 py-2">
                        {w.workspaceName || w.workspaceId}
                        {w.pendingResumeAt !== undefined && (
                          <span className="block text-[11px] text-warning">
                            already has a continue scheduled for {formatWhen(w.pendingResumeAt)}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {w.error ? (
                          <span className="text-danger">{w.error}</span>
                        ) : (
                          <>
                            {formatNumber(w.parents)} + {formatNumber(w.subsequences)} sub-seq
                          </>
                        )}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {w.error ? "—" : formatNumber(w.skipped)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-semibold">Jobs</h2>
        {jobs.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No jobs yet. A job keeps going after you close this tab, and its
            scheduled continue runs on the server.
          </p>
        ) : (
          jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              serverKey={serverKey}
              onAbort={(id) => act(() => abortPauseCampaigns(id))}
              onResumeNow={(id) => act(() => resumePauseCampaignsNow(id))}
              onCancelResume={(id) => act(() => cancelPauseCampaignsResume(id))}
              onRemove={(id) => act(() => deletePauseCampaignsJob(id))}
            />
          ))
        )}
      </div>

      {toast && (
        <div className="fixed bottom-5 right-5 z-50 animate-fade-in">
          <div className="pv-card flex items-center gap-3 border-success/40 px-4 py-3 shadow-card">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-success/15 text-success">
              <CheckIcon size={16} />
            </span>
            <span className="text-sm font-medium">{toast}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

const STATUS_META: Record<PauseCampaignsJob["status"], { label: string; className: string }> = {
  running: { label: "Pausing", className: "bg-accent/10 text-accent" },
  paused: { label: "Paused", className: "bg-warning/10 text-warning" },
  resuming: { label: "Resuming", className: "bg-accent/10 text-accent" },
  done: { label: "Done", className: "bg-success/10 text-success" },
  aborted: { label: "Stopped", className: "bg-muted text-muted-foreground" },
  interrupted: { label: "Interrupted", className: "bg-warning/10 text-warning" },
  error: { label: "Error", className: "bg-danger/10 text-danger" },
};

function JobCard({
  job,
  serverKey,
  onAbort,
  onResumeNow,
  onCancelResume,
  onRemove,
}: {
  job: PauseCampaignsJob;
  serverKey: boolean | null;
  onAbort: (id: string) => void | Promise<void>;
  onResumeNow: (id: string) => void | Promise<void>;
  onCancelResume: (id: string) => void | Promise<void>;
  onRemove: (id: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const status = STATUS_META[job.status] ?? STATUS_META.error;
  const active = job.status === "running" || job.status === "resuming";

  const paused = job.workspaces.reduce((s, w) => s + w.campaigns.length, 0);
  const parents = job.workspaces.reduce(
    (s, w) => s + w.campaigns.filter((c) => c.kind === "parent").length,
    0
  );
  const subs = paused - parents;
  const resumed = job.workspaces.reduce(
    (s, w) => s + w.campaigns.filter((c) => c.resumedAt !== undefined).length,
    0
  );
  const resumeFailed = job.workspaces.reduce(
    (s, w) => s + w.campaigns.filter((c) => c.resumeError && c.resumedAt === undefined).length,
    0
  );
  const pauseFailed = job.workspaces.reduce((s, w) => s + w.pauseErrors.length, 0);
  const resumePending = job.resumeAt !== undefined && job.resumedAt === undefined;
  const canResumeNow =
    !active && paused > 0 && (job.resumedAt === undefined || resumeFailed > 0);

  return (
    <div className="pv-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${status.className}`}>
            {active && <Spinner size={10} />} {status.label}
          </span>
          <span className="truncate text-sm font-medium">{job.label}</span>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(job.createdAt)}</span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label="Campaigns paused" value={parents} />
        <Metric label="Sub-sequences paused" value={subs} />
        <Metric
          label={job.resumedAt !== undefined ? "Continued" : "To continue"}
          value={job.resumedAt !== undefined ? resumed : resumePending ? paused : 0}
        />
        <Metric label="Errors" value={pauseFailed + resumeFailed} danger={pauseFailed + resumeFailed > 0} />
      </div>

      {resumePending && (
        <p className="mt-3 flex items-start gap-1.5 text-xs">
          <ClockIcon size={13} className="mt-0.5 shrink-0 text-warning" />
          <span>
            {job.resumeBlocked === "no-key" ? (
              <span className="text-warning">
                The continue was due {formatWhen(job.resumeAt!)} but couldn&apos;t run: the
                server restarted since the pause and has no{" "}
                <span className="font-mono">PLUSVIBE_API_KEY</span>. Press{" "}
                <span className="font-medium">Continue now</span> to do it with your key.
              </span>
            ) : (
              <>
                Continues{" "}
                <span className="font-medium text-foreground">{formatWhen(job.resumeAt!)}</span>{" "}
                · in {relativeFromNow(job.resumeAt!)}
                {serverKey === false && (
                  <span className="text-muted-foreground">
                    {" "}
                    · fires on its own only while the app stays up (no server key)
                  </span>
                )}
              </>
            )}
          </span>
        </p>
      )}
      {job.resumedAt !== undefined && (
        <p className="mt-3 text-xs text-muted-foreground">
          Continued {formatWhen(job.resumedAt)}
          {job.resumeTrigger === "manual" ? " by hand" : " on schedule"}
          {job.resumeKeySource === "server" ? " using the server key" : ""}
          {resumeFailed > 0 ? ` · ${formatNumber(resumeFailed)} could not be continued` : ""}.
        </p>
      )}
      {job.status === "interrupted" && (
        <p className="mt-3 text-xs text-warning">
          Interrupted by a server restart part-way through pausing. What was
          paused is listed below and is still covered by the scheduled continue.
        </p>
      )}
      {job.errors.length > 0 && (
        <div className="mt-3 space-y-1">
          {job.errors.slice(0, 3).map((e, i) => (
            <p key={i} className="flex gap-1.5 text-xs text-warning">
              <AlertIcon size={13} className="mt-0.5 shrink-0" />
              <span>{e}</span>
            </p>
          ))}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {job.status === "running" && (
          <button type="button" className="pv-btn-ghost" onClick={() => onAbort(job.id)}>
            Stop task
          </button>
        )}
        {canResumeNow && (
          <button type="button" className="pv-btn-ghost" onClick={() => onResumeNow(job.id)}>
            <PlayIcon size={14} />
            {resumeFailed > 0 && job.resumedAt !== undefined ? "Retry failed" : "Continue now"}
          </button>
        )}
        {resumePending && !active && (
          <button type="button" className="pv-btn-ghost" onClick={() => onCancelResume(job.id)}>
            Cancel scheduled continue
          </button>
        )}
        {!active && (
          <RemoveJobButton
            onRemove={() => onRemove(job.id)}
            disabled={resumePending}
          />
        )}
        <button type="button" className="pv-btn-ghost" onClick={() => setOpen((v) => !v)}>
          {open ? "Hide details" : "Details"}
        </button>
        {resumePending && !active && (
          <span className="text-[11px] text-muted-foreground">
            Cancel the scheduled continue before removing.
          </span>
        )}
      </div>

      {open && (
        <div className="pv-scroll mt-3 max-h-80 space-y-3 overflow-y-auto rounded-xl border border-border p-3 text-xs">
          {job.workspaces.map((w) => (
            <div key={w.workspaceId}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">{w.workspaceName || w.workspaceId}</span>
                <span className="text-muted-foreground">
                  {w.error
                    ? "not paused"
                    : `${formatNumber(w.campaigns.length)} paused · ${formatNumber(w.skipped)} left alone`}
                </span>
              </div>
              {w.error && <p className="mt-1 text-danger">{w.error}</p>}
              {w.campaigns.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {w.campaigns.map((c) => (
                    <li key={c.id} className="flex justify-between gap-3">
                      <span className="min-w-0 truncate">
                        {c.kind === "subseq" && <span className="text-muted-foreground">↳ </span>}
                        {c.name}
                      </span>
                      <span className="shrink-0 text-muted-foreground">
                        {c.resumedAt !== undefined
                          ? <span className="text-success">continued</span>
                          : c.resumeError
                            ? <span className="text-danger">{c.resumeError}</span>
                            : "paused"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {w.pauseErrors.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {w.pauseErrors.map((e) => (
                    <li key={e.id} className="flex justify-between gap-3">
                      <span className="min-w-0 truncate">{e.name}</span>
                      <span className="shrink-0 text-danger">could not pause: {e.reason}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return (
    <div className="rounded-xl border border-border p-2.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold tabular-nums ${danger ? "text-danger" : ""}`}>
        {formatNumber(value)}
      </div>
    </div>
  );
}

// --- Time helpers ------------------------------------------------------------

/** Tomorrow at 08:00 local, as a datetime-local value. */
function defaultResumeLocal(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return toLocalInputValue(d);
}

function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatWhen(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function timezoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "local time";
  }
}

function relativeFromNow(ts: number): string {
  const diff = ts - Date.now();
  const abs = Math.abs(diff);
  const m = Math.round(abs / 60000);
  const text =
    m < 60
      ? `${m} min`
      : m < 60 * 48
        ? `${Math.round(m / 60)} h`
        : `${Math.round(m / 60 / 24)} days`;
  return diff < 0 ? `${text} ago` : text;
}

function relativeTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function errMessage(err: unknown): string {
  return err instanceof ApiClientError
    ? err.message
    : err instanceof Error
      ? err.message
      : "Something went wrong";
}
