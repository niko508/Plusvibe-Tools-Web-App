"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Workspace } from "@/lib/plusvibe-types";
import type { CopyReplaceJob } from "@/lib/jobs/copy-replace-types";
import type { ReplaceTarget } from "@/lib/copy-sections/edit";
import { validateEdit } from "@/lib/copy-sections/edit";
import {
  startCopyReplace,
  listCopyReplaceJobs,
  confirmCopyReplace,
  cancelCopyReplace,
  abortCopyReplace,
  deleteCopyReplaceJob,
  ApiClientError,
} from "@/lib/api-client";
import { formatNumber } from "@/lib/format";
import { Spinner, RemoveJobButton } from "@/components/ui";
import { AlertIcon, CheckIcon, PenIcon, RefreshIcon } from "@/components/icons";

// Find & replace across every campaign in the selected workspaces, every step.
//
// Two phases with a stop between them. The scan reads everything and shows
// what would change per workspace and per campaign; nothing is written until
// you confirm. The apply then re-reads each campaign and writes it, skipping
// any that changed in the meantime. Both phases report progress as they go.

const POLL_MS = 2500;

export function CopyReplace({
  workspaces,
  selected,
  loading,
}: {
  workspaces: Workspace[];
  selected: Set<string>;
  loading: boolean;
}) {
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [target, setTarget] = useState<ReplaceTarget>("both");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [includeSubs, setIncludeSubs] = useState(false);
  const [jobs, setJobs] = useState<CopyReplaceJob[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const lock = useRef(false);

  const chosen = useMemo(
    () => workspaces.filter((w) => selected.has(w._id)).map((w) => ({ id: w._id, name: w.name })),
    [workspaces, selected]
  );

  const edit = { kind: "replace-text" as const, find, replace, target, caseSensitive };
  const problems = validateEdit(edit, 2);
  const active = jobs.find((j) => j.status === "scanning" || j.status === "applying" || j.status === "awaiting_confirmation") ?? null;
  const canStart = chosen.length > 0 && problems.length === 0 && !busy && !active;

  const refresh = useCallback(async () => {
    try {
      setJobs((await listCopyReplaceJobs()).jobs);
    } catch {
      // polling failure is not worth a banner
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const anyLive = jobs.some((j) => j.status === "scanning" || j.status === "applying");
  useEffect(() => {
    if (!anyLive) return;
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [anyLive, refresh]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  async function start() {
    if (!canStart || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await startCopyReplace({ workspaces: chosen, edit, includeSubsequences: includeSubs });
      setToast("Scanning… nothing is written until you confirm.");
      await refresh();
    } catch (err) {
      setError(errMessage(err));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setError(null);
    try {
      await fn();
      if (done) setToast(done);
      await refresh();
    } catch (err) {
      setError(errMessage(err));
    }
  };

  return (
    <div className="space-y-4">
      <div className="pv-card space-y-4 p-4 sm:p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Find</label>
            <textarea className="pv-input min-h-[64px] font-mono text-sm" placeholder="{{sender_signature}}" value={find} onChange={(e) => setFind(e.target.value)} spellCheck={false} />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Replace with</label>
            <textarea className="pv-input min-h-[64px] font-mono text-sm" placeholder="{{sender_first_name}}" value={replace} onChange={(e) => setReplace(e.target.value)} spellCheck={false} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="text-muted-foreground">Look in</span>
          {(["both", "body", "subject"] as ReplaceTarget[]).map((t) => (
            <button key={t} type="button" onClick={() => setTarget(t)} className={`pv-chip ${target === t ? "pv-chip-active" : "hover:text-foreground"}`}>
              {t === "both" ? "subject and body" : t}
            </button>
          ))}
          <label className="ml-2 flex items-center gap-1.5 text-muted-foreground">
            <input type="checkbox" className="h-3.5 w-3.5 accent-accent" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} />
            Match case
          </label>
          <label className="flex items-center gap-1.5 text-muted-foreground">
            <input type="checkbox" className="h-3.5 w-3.5 accent-accent" checked={includeSubs} onChange={(e) => setIncludeSubs(e.target.checked)} />
            Include sub-sequences
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          Every <span className="text-foreground">active or paused</span> campaign in each selected workspace, every step.
          Drafts, completed and archived campaigns are left alone. The scan reads everything first and shows what would
          change; nothing is written until you confirm. A campaign someone edits between the scan and the apply is skipped
          rather than overwritten.
        </p>
        {problems.length > 0 && find.trim() !== "" && (
          <p className="flex gap-1.5 text-xs text-warning">
            <AlertIcon size={13} className="mt-0.5 shrink-0" />
            {problems.join(" ")}
          </p>
        )}
        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger">
            <AlertIcon size={16} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="pv-btn-primary disabled:opacity-50" disabled={!canStart} onClick={start}>
            {busy ? <Spinner /> : <RefreshIcon size={16} />}
            Scan {formatNumber(chosen.length)} workspace{chosen.length === 1 ? "" : "s"}
          </button>
          {active && (
            <span className="text-xs text-muted-foreground">
              {active.status === "awaiting_confirmation"
                ? "A scan is waiting for your confirmation below — confirm or cancel it before starting another."
                : "A job is running — it has to finish before another can start."}
            </span>
          )}
          {chosen.length === 0 && !loading && !active && (
            <span className="text-xs text-muted-foreground">Pick some workspaces above first.</span>
          )}
        </div>
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-semibold">Jobs</h2>
        {jobs.length === 0 ? (
          <p className="text-xs text-muted-foreground">No jobs yet. A job keeps going after you close this tab.</p>
        ) : (
          jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              onConfirm={(id) => act(() => confirmCopyReplace(id), "Applying… you can close this tab.")}
              onCancel={(id) => act(() => cancelCopyReplace(id))}
              onAbort={(id) => act(() => abortCopyReplace(id))}
              onRemove={(id) => act(() => deleteCopyReplaceJob(id))}
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

const STATUS: Record<CopyReplaceJob["status"], { label: string; className: string }> = {
  scanning: { label: "Scanning", className: "bg-accent/10 text-accent" },
  awaiting_confirmation: { label: "Waiting for you", className: "bg-warning/10 text-warning" },
  applying: { label: "Applying", className: "bg-accent/10 text-accent" },
  done: { label: "Done", className: "bg-success/10 text-success" },
  cancelled: { label: "Cancelled", className: "bg-muted text-muted-foreground" },
  aborted: { label: "Stopped", className: "bg-muted text-muted-foreground" },
  interrupted: { label: "Interrupted", className: "bg-warning/10 text-warning" },
  error: { label: "Error", className: "bg-danger/10 text-danger" },
};

function JobCard({
  job,
  onConfirm,
  onCancel,
  onAbort,
  onRemove,
}: {
  job: CopyReplaceJob;
  onConfirm: (id: string) => void | Promise<void>;
  onCancel: (id: string) => void | Promise<void>;
  onAbort: (id: string) => void | Promise<void>;
  onRemove: (id: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(job.status === "awaiting_confirmation");
  // The card usually mounts mid-scan, so the initial value is false. When the
  // scan finishes, the breakdown is what needs reading before confirming —
  // open it rather than leave it behind a click.
  useEffect(() => {
    if (job.status === "awaiting_confirmation") setOpen(true);
  }, [job.status]);
  const s = STATUS[job.status] ?? STATUS.error;
  const liveNow = job.status === "scanning" || job.status === "applying";
  const p = job.progress;
  const totalWs = job.workspaces.length;
  const campaignsTotal = job.workspaces.reduce((n, w) => n + w.campaigns.length, 0);
  const toApply = p.campaignsToChange;
  const applyDone = p.campaignsApplied + p.campaignsFailed + p.campaignsSkipped;

  // Progress: during the scan, campaigns are discovered workspace by workspace,
  // so the bar tracks workspaces; during the apply the count is known.
  const pct =
    job.status === "scanning"
      ? totalWs > 0 ? Math.round((p.workspacesScanned / totalWs) * 100) : 0
      : job.status === "applying"
        ? toApply > 0 ? Math.round((applyDone / toApply) * 100) : 0
        : 100;

  return (
    <div className="pv-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${s.className}`}>
            {liveNow && <Spinner size={10} />} {s.label}
          </span>
          <span className="truncate font-mono text-sm">{job.label}</span>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(job.createdAt)}</span>
      </div>

      {/* Live progress */}
      <div className="mt-3">
        <div className="mb-1.5 flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {job.status === "scanning" &&
              `Scanning · ${formatNumber(p.workspacesScanned)} of ${formatNumber(totalWs)} workspaces · ${formatNumber(p.campaignsScanned)} campaigns read`}
            {job.status === "awaiting_confirmation" &&
              `Scan finished · ${formatNumber(p.campaignsScanned)} campaigns read across ${formatNumber(totalWs)} workspaces`}
            {job.status === "applying" && `Applying · ${formatNumber(applyDone)} of ${formatNumber(toApply)} campaigns`}
            {!liveNow && job.status !== "awaiting_confirmation" && `${formatNumber(p.campaignsScanned)} campaigns read`}
          </span>
          <span className="tabular-nums">{pct}%</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-accent transition-all duration-300" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label="Campaigns read" value={p.campaignsScanned} />
        <Metric label={job.status === "done" ? "Campaigns changed" : "Campaigns to change"} value={job.status === "done" || job.status === "applying" ? p.campaignsApplied : toApply} tone={toApply > 0 ? "success" : undefined} />
        <Metric label="Variations to change" value={p.variationsToChange} />
        <Metric label="Skipped / failed" value={p.campaignsSkipped + p.campaignsFailed} tone={p.campaignsSkipped + p.campaignsFailed > 0 ? "danger" : undefined} />
      </div>

      {job.status === "awaiting_confirmation" && (
        <div className="mt-3 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2.5 text-sm">
          {toApply === 0 ? (
            <>Nothing would change — the text wasn&apos;t found in any campaign. Nothing to apply.</>
          ) : (
            <>
              <span className="font-medium">{formatNumber(p.variationsToChange)} variations</span> across{" "}
              <span className="font-medium">{formatNumber(toApply)} campaigns</span> would change. Check the breakdown
              below, then confirm. Nothing has been written yet.
            </>
          )}
        </div>
      )}
      {job.status === "interrupted" && (
        <p className="mt-3 text-xs text-warning">
          Interrupted by a server restart. Campaigns already applied stay applied; run the same scan again to finish
          the rest — they will show as unchanged.
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
          {job.errors.length > 3 && <p className="text-xs text-muted-foreground">+{job.errors.length - 3} more in the breakdown</p>}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {job.status === "awaiting_confirmation" && toApply > 0 && (
          <button type="button" className="pv-btn-primary" onClick={() => onConfirm(job.id)}>
            <PenIcon size={16} />
            Apply to {formatNumber(toApply)} campaign{toApply === 1 ? "" : "s"}
          </button>
        )}
        {job.status === "awaiting_confirmation" && (
          <button type="button" className="pv-btn-ghost" onClick={() => onCancel(job.id)}>
            {toApply > 0 ? "Cancel — write nothing" : "Dismiss"}
          </button>
        )}
        {liveNow && (
          <button type="button" className="pv-btn-ghost" onClick={() => onAbort(job.id)}>
            Stop task
          </button>
        )}
        {!liveNow && job.status !== "awaiting_confirmation" && <RemoveJobButton onRemove={() => onRemove(job.id)} />}
        <button type="button" className="pv-btn-ghost" onClick={() => setOpen((v) => !v)}>
          {open ? "Hide breakdown" : "Breakdown"}
        </button>
      </div>

      {open && (
        <div className="pv-scroll mt-3 max-h-96 space-y-3 overflow-y-auto rounded-xl border border-border p-3 text-xs">
          {job.workspaces.map((w) => {
            const wsChange = w.campaigns.filter((c) => c.state === "would-change" || c.state === "applied" || c.state === "applying");
            return (
              <div key={w.workspaceId}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">
                    {w.workspaceName || w.workspaceId}
                    {w.state === "scanning" && <Spinner size={10} />}
                  </span>
                  <span className="text-muted-foreground">
                    {w.error
                      ? "not scanned"
                      : w.state === "pending"
                        ? "waiting"
                        : `${formatNumber(wsChange.length)} of ${formatNumber(w.campaigns.length)} campaigns${w.skippedOutOfScope ? ` · ${formatNumber(w.skippedOutOfScope)} out of scope` : ""}`}
                  </span>
                </div>
                {w.error && <p className="mt-1 text-danger">{w.error}</p>}
                {w.campaigns.length > 0 && (
                  <ul className="mt-1 space-y-0.5">
                    {w.campaigns
                      .filter((c) => c.state !== "unchanged" || job.status === "scanning")
                      .map((c) => (
                        <li key={c.campaignId} className="flex justify-between gap-3">
                          <span className="min-w-0 truncate">
                            {c.campaignType === "subseq" && <span className="text-muted-foreground">↳ </span>}
                            {c.campaignName}
                            {c.steps.filter((st) => st.changed > 0).length > 0 && (
                              <span className="text-muted-foreground">
                                {" "}
                                · {c.steps.filter((st) => st.changed > 0).map((st) => `step ${st.step}: ${st.changed}/${st.total}`).join(", ")}
                              </span>
                            )}
                          </span>
                          <span className="shrink-0">
                            {c.state === "would-change" && <span className="text-success">{formatNumber(c.changed)} would change</span>}
                            {c.state === "applied" && (
                              <span className={c.verified ? "text-success" : "text-warning"}>
                                {formatNumber(c.changed)} changed{c.verified ? "" : " · not confirmed"}
                              </span>
                            )}
                            {c.state === "applying" && <Spinner size={10} />}
                            {c.state === "scanning" && <Spinner size={10} />}
                            {c.state === "unchanged" && <span className="text-muted-foreground">not found</span>}
                            {c.state === "pending" && <span className="text-muted-foreground">waiting</span>}
                            {c.state === "skipped" && <span className="text-warning">{c.error}</span>}
                            {c.state === "error" && <span className="text-danger">{c.error}</span>}
                          </span>
                        </li>
                      ))}
                    {w.campaigns.filter((c) => c.state === "unchanged").length > 0 && job.status !== "scanning" && (
                      <li className="text-muted-foreground">
                        {formatNumber(w.campaigns.filter((c) => c.state === "unchanged").length)} campaign
                        {w.campaigns.filter((c) => c.state === "unchanged").length === 1 ? "" : "s"} without the text
                      </li>
                    )}
                  </ul>
                )}
              </div>
            );
          })}
          {campaignsTotal === 0 && job.status !== "scanning" && <p className="text-muted-foreground">No campaigns in scope.</p>}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: "success" | "danger" }) {
  return (
    <div className="rounded-xl border border-border p-2.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold tabular-nums ${tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : ""}`}>
        {formatNumber(value)}
      </div>
    </div>
  );
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
  return err instanceof ApiClientError ? err.message : err instanceof Error ? err.message : "Something went wrong";
}
