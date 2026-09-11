"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Workspace } from "@/lib/plusvibe-types";
import type { CampaignSettingsJob } from "@/lib/jobs/campaign-settings-types";
import {
  SETTINGS,
  prepareChanges,
  specFor,
  type SettingChange,
} from "@/lib/campaign-settings/settings";
import {
  startCampaignSettings,
  listCampaignSettingsJobs,
  abortCampaignSettingsJob,
  deleteCampaignSettingsJob,
  ApiClientError,
} from "@/lib/api-client";
import { formatNumber } from "@/lib/format";
import { Spinner, RemoveJobButton } from "@/components/ui";
import { AlertIcon, CheckIcon, LayersIcon } from "@/components/icons";

// Changes campaign settings across every ACTIVE campaign in the selected
// workspaces. Tick the settings to change and say what they should be; the
// rest of each campaign's settings are left exactly as they are. Runs in the
// background with live progress; a campaign already set the wanted way is
// counted, not written.

const POLL_MS = 2500;

/** What each ticked setting is set to, keyed by setting. */
type Picked = Record<string, string | number>;

export function CampaignSettings({
  workspaces,
  selected,
  loading,
}: {
  workspaces: Workspace[];
  selected: Set<string>;
  loading: boolean;
}) {
  const [picked, setPicked] = useState<Picked>({});
  const [includeSubs, setIncludeSubs] = useState(false);
  const [jobs, setJobs] = useState<CampaignSettingsJob[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const lock = useRef(false);

  const chosen = useMemo(
    () => workspaces.filter((w) => selected.has(w._id)).map((w) => ({ id: w._id, name: w.name })),
    [workspaces, selected]
  );

  const inputs: SettingChange[] = Object.entries(picked).map(([key, value]) => ({ key, value }));
  const prepared = prepareChanges(inputs);
  const active = jobs.find((j) => j.status === "running") ?? null;
  const canStart = chosen.length > 0 && prepared.changes.length > 0 && prepared.problems.length === 0 && !busy && !active;

  function toggle(key: string, on: boolean) {
    setPicked((prev) => {
      const next = { ...prev };
      if (!on) {
        delete next[key];
        return next;
      }
      const spec = specFor(key);
      next[key] = spec?.kind === "toggle" ? "yes" : spec?.kind === "choice" ? spec.choices?.[0].value ?? "" : spec?.min ?? 0;
      return next;
    });
  }
  function setValue(key: string, value: string | number) {
    setPicked((prev) => ({ ...prev, [key]: value }));
  }

  const refresh = useCallback(async () => {
    try {
      setJobs((await listCampaignSettingsJobs()).jobs);
    } catch {
      // polling failure is not worth a banner
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const anyLive = jobs.some((j) => j.status === "running");
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
      await startCampaignSettings({ workspaces: chosen, changes: prepared.changes, includeSubsequences: includeSubs });
      setToast("Updating… you can close this tab, the job keeps going.");
      await refresh();
    } catch (err) {
      setError(errMessage(err));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(errMessage(err));
    }
  };

  const n = prepared.changes.length;

  return (
    <div className="space-y-4">
      <div className="pv-card space-y-4 p-4 sm:p-5">
        <div>
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">
            Settings to change <span className="font-normal">· {formatNumber(n)} picked · everything not ticked is left as it is</span>
          </div>
          <div className="divide-y divide-border rounded-xl border border-border">
            {SETTINGS.map((s) => {
              const on = s.key in picked;
              const value = picked[s.key];
              return (
                <div key={s.key} className={`flex flex-wrap items-center gap-3 px-3 py-2.5 ${on ? "" : "opacity-80"}`}>
                  <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 accent-accent"
                      checked={on}
                      onChange={(e) => toggle(s.key, e.target.checked)}
                      aria-label={`Change ${s.label}`}
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{s.label}</span>
                      <span className="block text-xs text-muted-foreground">{s.hint}</span>
                    </span>
                  </label>
                  {on && s.kind === "toggle" && (
                    <div className="flex items-center gap-1 text-xs" role="radiogroup" aria-label={s.label}>
                      {(["yes", "no"] as const).map((v) => (
                        <button
                          key={v}
                          type="button"
                          role="radio"
                          aria-checked={value === v}
                          onClick={() => setValue(s.key, v)}
                          className={`pv-chip ${value === v ? "pv-chip-active" : "hover:text-foreground"}`}
                        >
                          {v === "yes" ? "On" : "Off"}
                        </button>
                      ))}
                    </div>
                  )}
                  {on && s.kind === "choice" && (
                    <select className="pv-input w-auto text-sm" value={String(value)} onChange={(e) => setValue(s.key, e.target.value)} aria-label={s.label}>
                      {s.choices?.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  )}
                  {on && s.kind === "number" && (
                    <div className="flex items-center gap-1.5 text-sm">
                      {s.unit === "$" && <span className="text-muted-foreground">$</span>}
                      <input
                        type="number"
                        className="pv-input w-24 text-sm"
                        min={s.min}
                        value={String(value)}
                        onChange={(e) => setValue(s.key, e.target.value === "" ? "" : Number(e.target.value))}
                        aria-label={s.label}
                      />
                      {s.unit === "%" && <span className="text-muted-foreground">%</span>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" className="h-3.5 w-3.5 accent-accent" checked={includeSubs} onChange={(e) => setIncludeSubs(e.target.checked)} />
          Include sub-sequences
        </label>

        <p className="text-xs text-muted-foreground">
          Every <span className="font-medium text-foreground">active</span> campaign in each selected workspace. Paused,
          draft, completed and archived campaigns are left alone. Only the ticked settings are written, and only on
          campaigns where they differ; each campaign is read back afterwards to confirm.
        </p>

        {prepared.problems.length > 0 && (
          <p className="flex gap-1.5 text-xs text-warning">
            <AlertIcon size={13} className="mt-0.5 shrink-0" />
            {prepared.problems.join(" ")}
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
            {busy ? <Spinner /> : <LayersIcon size={16} />}
            Apply {formatNumber(n)} setting{n === 1 ? "" : "s"} in {formatNumber(chosen.length)} workspace{chosen.length === 1 ? "" : "s"}
          </button>
          {active && <span className="text-xs text-muted-foreground">A job is running — it has to finish before another can start.</span>}
          {chosen.length === 0 && !loading && !active && <span className="text-xs text-muted-foreground">Pick some workspaces above first.</span>}
          {chosen.length > 0 && n === 0 && !active && <span className="text-xs text-muted-foreground">Tick at least one setting.</span>}
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
              onAbort={(id) => act(() => abortCampaignSettingsJob(id))}
              onRemove={(id) => act(() => deleteCampaignSettingsJob(id))}
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

const STATUS: Record<CampaignSettingsJob["status"], { label: string; className: string }> = {
  running: { label: "Running", className: "bg-accent/10 text-accent" },
  done: { label: "Done", className: "bg-success/10 text-success" },
  aborted: { label: "Stopped", className: "bg-muted text-muted-foreground" },
  interrupted: { label: "Interrupted", className: "bg-warning/10 text-warning" },
  error: { label: "Error", className: "bg-danger/10 text-danger" },
};

function JobCard({
  job,
  onAbort,
  onRemove,
}: {
  job: CampaignSettingsJob;
  onAbort: (id: string) => void | Promise<void>;
  onRemove: (id: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const s = STATUS[job.status] ?? STATUS.error;
  const liveNow = job.status === "running";
  const p = job.progress;
  const totalWs = job.workspaces.length;
  // Campaigns are discovered workspace by workspace, so the bar tracks
  // workspaces, with the current one's campaigns as the fraction inside it.
  const current = job.workspaces.find((w) => w.state === "listing" || w.state === "updating");
  const inner = current && current.campaigns.length > 0
    ? current.campaigns.filter((c) => c.state !== "pending" && c.state !== "updating").length / current.campaigns.length
    : 0;
  const pct = liveNow ? (totalWs > 0 ? Math.round(((p.workspacesDone + inner) / totalWs) * 100) : 0) : 100;
  const labelFor = (key: string) => specFor(key)?.label ?? key;

  return (
    <div className="pv-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${s.className}`}>
            {liveNow && <Spinner size={10} />} {s.label}
          </span>
          <span className="truncate text-sm">{job.label}</span>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(job.createdAt)}</span>
      </div>

      <div className="mt-3">
        <div className="mb-1.5 flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {liveNow
              ? `${formatNumber(p.workspacesDone)} of ${formatNumber(totalWs)} workspaces · ${formatNumber(p.campaignsDone)} of ${formatNumber(p.campaignsFound)} campaigns${current ? ` · ${current.workspaceName || current.workspaceId}: ${current.state === "listing" ? "listing campaigns" : "updating"}` : ""}`
              : `${formatNumber(p.workspacesDone)} of ${formatNumber(totalWs)} workspaces · ${formatNumber(p.campaignsFound)} active campaigns`}
          </span>
          <span className="tabular-nums">{pct}%</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-accent transition-all duration-300" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label="Active campaigns" value={p.campaignsFound} />
        <Metric label="Changed" value={p.changed} tone={p.changed > 0 ? "success" : undefined} />
        <Metric label="Already set" value={p.already} />
        <Metric label="Failed" value={p.failed} tone={p.failed > 0 ? "danger" : undefined} />
      </div>
      {job.status === "interrupted" && (
        <p className="mt-3 text-xs text-warning">
          Interrupted by a server restart. Campaigns already changed stay changed; run the same settings again to
          finish the rest — they will show as already set.
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
        {liveNow && (
          <button type="button" className="pv-btn-ghost" onClick={() => onAbort(job.id)}>
            Stop task
          </button>
        )}
        {!liveNow && <RemoveJobButton onRemove={() => onRemove(job.id)} />}
        <button type="button" className="pv-btn-ghost" onClick={() => setOpen((v) => !v)}>
          {open ? "Hide breakdown" : "Breakdown"}
        </button>
      </div>

      {open && (
        <div className="pv-scroll mt-3 max-h-96 space-y-3 overflow-y-auto rounded-xl border border-border p-3 text-xs">
          {job.workspaces.map((w) => {
            const already = w.campaigns.filter((c) => c.state === "already").length;
            return (
              <div key={w.workspaceId}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">
                    {w.workspaceName || w.workspaceId}
                    {(w.state === "listing" || w.state === "updating") && <Spinner size={10} />}
                  </span>
                  <span className="text-muted-foreground">
                    {w.error
                      ? "not updated"
                      : w.state === "pending"
                        ? "waiting"
                        : w.state === "listing"
                          ? "listing campaigns"
                          : `${formatNumber(w.campaigns.length)} active campaign${w.campaigns.length === 1 ? "" : "s"}${w.skippedNotActive ? ` · ${formatNumber(w.skippedNotActive)} not active, left alone` : ""}`}
                  </span>
                </div>
                {w.error && <p className="mt-1 text-danger">{w.error}</p>}
                {w.campaigns.length > 0 && (
                  <ul className="mt-1 space-y-0.5">
                    {w.campaigns
                      .filter((c) => c.state !== "already")
                      .map((c) => (
                        <li key={c.campaignId} className="flex justify-between gap-3">
                          <span className="min-w-0 truncate">
                            {c.campaignType === "subseq" && <span className="text-muted-foreground">↳ </span>}
                            {c.campaignName}
                            {c.needed.length > 0 && <span className="text-muted-foreground"> · {c.needed.map(labelFor).join(", ")}</span>}
                          </span>
                          <span className="shrink-0">
                            {c.state === "changed" && (
                              <span className={c.verified ? "text-success" : "text-warning"}>
                                changed{c.verified ? "" : ` · not confirmed: ${(c.unverified ?? []).map(labelFor).join(", ")}`}
                              </span>
                            )}
                            {c.state === "updating" && <Spinner size={10} />}
                            {c.state === "pending" && <span className="text-muted-foreground">waiting</span>}
                            {c.state === "error" && <span className="text-danger">{c.error}</span>}
                          </span>
                        </li>
                      ))}
                    {already > 0 && (
                      <li className="text-muted-foreground">
                        {formatNumber(already)} campaign{already === 1 ? "" : "s"} already set this way
                      </li>
                    )}
                  </ul>
                )}
                {w.state === "done" && w.campaigns.length === 0 && !w.error && (
                  <p className="mt-1 text-muted-foreground">No active campaigns.</p>
                )}
              </div>
            );
          })}
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
