"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Workspace } from "@/lib/plusvibe-types";
import type {
  Remove50Job,
  Remove50JobStatus,
  Remove50DomainPlan,
} from "@/lib/jobs/remove-50-types";
import {
  fetchWorkspaces,
  fetchAccountsPage,
  startRemove50,
  listRemove50Jobs,
  abortRemove50,
  ApiClientError,
} from "@/lib/api-client";
import { useApiKey } from "@/lib/use-api-key";
import { formatNumber, domainFromEmail } from "@/lib/format";
import { ConnectPrompt } from "@/components/connect-prompt";
import { StatCard } from "@/components/stat-card";
import { Spinner, EmptyState } from "@/components/ui";
import {
  FireIcon,
  AlertIcon,
  RefreshIcon,
  ChevronDownIcon,
  TrashIcon,
  CheckIcon,
} from "@/components/icons";
import {
  DEFAULT_TARGET,
  DEFAULT_EXCLUDED_WORKSPACE,
  WARMUP_SETTINGS,
  SETTINGS_SUMMARY,
} from "./settings";

interface InboxLite {
  id: string;
  email: string;
  health: number | null;
  warmupActive: boolean;
}

interface DomainPlan {
  domain: string;
  total: number;
  toDelete: number;
  keep: number;
  deleteInboxes: InboxLite[];
  keepInboxes: InboxLite[];
}

export function Remove50Tool() {
  const { hasKey, ready } = useApiKey();

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(false);
  const [workspaceId, setWorkspaceId] = useState("");
  const [target] = useState(DEFAULT_TARGET);

  const [loading, setLoading] = useState(false);
  const [loadProgress, setLoadProgress] = useState({ inboxes: 0, pages: 0 });
  const [plans, setPlans] = useState<DomainPlan[] | null>(null);
  const [loadedForWs, setLoadedForWs] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const loadAbortRef = useRef<AbortController | null>(null);

  const [confirmText, setConfirmText] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [jobs, setJobs] = useState<Remove50Job[]>([]);
  const [highlightJobId, setHighlightJobId] = useState<string | null>(null);

  // --- Workspaces ----------------------------------------------------------
  const loadWorkspaces = useCallback(async () => {
    setWorkspacesLoading(true);
    setError(null);
    try {
      const res = await fetchWorkspaces();
      const list = res.workspaces ?? [];
      setWorkspaces(list);
      if (list.length) {
        setWorkspaceId((prev) => {
          if (prev) return prev;
          const warmup = list.find(
            (w) => w.name.trim().toLowerCase() === DEFAULT_EXCLUDED_WORKSPACE
          );
          return warmup?._id ?? list[0]._id;
        });
      }
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setWorkspacesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (ready && hasKey) void loadWorkspaces();
  }, [ready, hasKey, loadWorkspaces]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(t);
  }, [toast]);

  // --- Jobs polling --------------------------------------------------------
  const refreshJobs = useCallback(async () => {
    try {
      const res = await listRemove50Jobs();
      setJobs(res.jobs ?? []);
    } catch {
      // transient; keep last known list
    }
  }, []);

  useEffect(() => {
    if (!(ready && hasKey)) return;
    void refreshJobs();
    const interval = setInterval(() => void refreshJobs(), 2500);
    return () => clearInterval(interval);
  }, [ready, hasKey, refreshJobs]);

  // --- Load + build plans --------------------------------------------------
  const PAGE_SIZE = 100;
  async function loadPlans() {
    if (!workspaceId) return;
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    const { signal } = controller;

    setLoading(true);
    setLoadProgress({ inboxes: 0, pages: 0 });
    setError(null);
    setPlans(null);
    setConfirmText("");
    try {
      // Page through the workspace's inboxes, updating a live counter so a big
      // "Inbox Warmup" workspace shows progress instead of a silent spinner.
      const accounts: InboxLite[] = [];
      const byDomain = new Map<string, InboxLite[]>();
      let skip = 0;
      let page = 0;
      while (true) {
        const res = await fetchAccountsPage(
          { workspace_id: workspaceId, skip, limit: PAGE_SIZE },
          signal
        );
        page += 1;
        for (const a of res.accounts ?? []) {
          if (!a.id || !a.email) continue;
          const domain = domainFromEmail(a.email);
          if (!domain) continue;
          const inbox: InboxLite = {
            id: a.id,
            email: a.email,
            health: typeof a.warmup_health === "number" ? a.warmup_health : null,
            warmupActive: (a.warmup_status ?? "").toUpperCase() === "ACTIVE",
          };
          accounts.push(inbox);
          const arr = byDomain.get(domain);
          if (arr) arr.push(inbox);
          else byDomain.set(domain, [inbox]);
        }
        setLoadProgress({ inboxes: accounts.length, pages: page });
        if (!res.hasMore) break;
        skip += PAGE_SIZE;
      }

      const built: DomainPlan[] = [];
      for (const [domain, inboxes] of byDomain) {
        // Sort worst warmup health first; unknown health kept last.
        inboxes.sort(
          (a, b) =>
            (a.health ?? Number.POSITIVE_INFINITY) -
            (b.health ?? Number.POSITIVE_INFINITY)
        );
        const total = inboxes.length;
        const toDelete = Math.max(0, total - target);
        built.push({
          domain,
          total,
          toDelete,
          keep: total - toDelete,
          deleteInboxes: inboxes.slice(0, toDelete),
          keepInboxes: inboxes.slice(toDelete),
        });
      }
      built.sort((a, b) => b.toDelete - a.toDelete || b.total - a.total);
      setPlans(built);
      setLoadedForWs(workspaceId);
    } catch (err) {
      if (!isAbort(err)) setError(errMessage(err));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  function cancelLoad() {
    loadAbortRef.current?.abort();
    setLoading(false);
  }

  // --- Derived -------------------------------------------------------------
  const trimmed = (plans ?? []).filter((p) => p.toDelete > 0);
  const totalToDelete = trimmed.reduce((s, p) => s + p.toDelete, 0);
  const totalKeep = trimmed.reduce((s, p) => s + p.keep, 0);
  const confirmArmed =
    confirmText.trim() === String(totalToDelete) ||
    confirmText.trim().toUpperCase() === "DELETE";
  const hasRunningJob = jobs.some((j) => j.status === "running");

  // --- Start background job ------------------------------------------------
  async function handleStart() {
    if (!plans || totalToDelete === 0 || starting) return;
    setStarting(true);
    setError(null);
    setToast(null);
    try {
      const wsName =
        workspaces.find((w) => w._id === workspaceId)?.name ?? "";
      const domains: Remove50DomainPlan[] = trimmed.map((p) => ({
        domain: p.domain,
        total: p.total,
        deleteEmails: p.deleteInboxes.map((i) => i.email),
        keepIds: p.keepInboxes.map((i) => i.id),
      }));

      const { jobId } = await startRemove50({
        label: `${wsName || "Workspace"} · ${trimmed.length} domain${
          trimmed.length === 1 ? "" : "s"
        } → ${target}`,
        workspaceId,
        workspaceName: wsName,
        target,
        settings: WARMUP_SETTINGS,
        domains,
      });

      setHighlightJobId(jobId);
      setTimeout(() => setHighlightJobId(null), 4000);
      setConfirmText("");
      setToast("Job started — it runs in the background, you can close this tab.");
      await refreshJobs();
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setStarting(false);
    }
  }

  async function handleAbortJob(id: string) {
    try {
      await abortRemove50(id);
      await refreshJobs();
    } catch {
      // ignore
    }
  }

  // --- Render --------------------------------------------------------------
  if (!ready) return <div className="pv-card h-40 animate-pulse" />;
  if (!hasKey) return <ConnectPrompt onConnected={loadWorkspaces} />;

  return (
    <div className="space-y-5">
      {/* Workspace + load */}
      <div className="pv-card space-y-4 p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="min-w-[220px] flex-1">
            <label className="mb-1.5 block text-sm font-medium">Workspace</label>
            <div className="relative">
              <select
                className="pv-input appearance-none pr-9"
                value={workspaceId}
                disabled={workspacesLoading || workspaces.length === 0}
                onChange={(e) => {
                  setWorkspaceId(e.target.value);
                  setPlans(null);
                  setLoadedForWs(null);
                  setConfirmText("");
                }}
              >
                {workspacesLoading && <option>Loading…</option>}
                {!workspacesLoading &&
                  workspaces.map((w) => (
                    <option key={w._id} value={w._id}>
                      {w.name}
                    </option>
                  ))}
              </select>
              <ChevronDownIcon
                size={16}
                className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Target per domain
            </label>
            <div className="pv-input flex w-28 items-center justify-center tabular-nums">
              {target}
            </div>
          </div>
          {loading ? (
            <button
              type="button"
              className="pv-btn-ghost"
              onClick={cancelLoad}
            >
              Cancel
            </button>
          ) : (
            <button
              type="button"
              className="pv-btn-primary"
              onClick={loadPlans}
              disabled={!workspaceId}
            >
              <RefreshIcon size={16} />
              {loadedForWs === workspaceId ? "Reload preview" : "Load & preview"}
            </button>
          )}
        </div>

        {loading && (
          <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm">
            <Spinner size={14} />
            <span className="text-muted-foreground">
              Loading inboxes…{" "}
              <strong className="text-foreground tabular-nums">
                {formatNumber(loadProgress.inboxes)}
              </strong>{" "}
              loaded
              {loadProgress.pages > 0 && (
                <span className="text-muted-foreground">
                  {" "}
                  ({formatNumber(loadProgress.pages)} page
                  {loadProgress.pages === 1 ? "" : "s"})
                </span>
              )}
            </span>
          </div>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          <AlertIcon size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Preview */}
      {plans && plans.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatCard label="Domains" value={formatNumber(plans.length)} />
            <StatCard label="Domains to trim" value={formatNumber(trimmed.length)} />
            <StatCard label="Inboxes to delete" value={formatNumber(totalToDelete)} />
            <StatCard label="Inboxes kept & reconfigured" value={formatNumber(totalKeep)} />
          </div>

          {/* Settings that will be applied */}
          <details className="pv-card px-4 py-3">
            <summary className="cursor-pointer text-sm font-medium">
              Warmup settings applied to kept inboxes
            </summary>
            <div className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
              {SETTINGS_SUMMARY.map((s) => (
                <div key={s.label} className="flex justify-between gap-3 border-b border-border/60 py-1.5 last:border-0">
                  <span className="text-muted-foreground">{s.label}</span>
                  <span className="font-medium">{s.value}</span>
                </div>
              ))}
            </div>
          </details>

          {/* Per-domain table */}
          <div className="pv-card overflow-hidden">
            <div className="pv-scroll overflow-x-auto">
              <table className="w-full min-w-[620px] text-sm">
                <thead>
                  <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3 text-left font-medium">Domain</th>
                    <th className="px-4 py-3 text-right font-medium">Inboxes now</th>
                    <th className="px-4 py-3 text-right font-medium">To delete</th>
                    <th className="px-4 py-3 text-right font-medium">Keep</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {plans.map((p) => (
                    <PlanRow
                      key={p.domain}
                      plan={p}
                      expanded={expanded === p.domain}
                      onToggle={() =>
                        setExpanded(expanded === p.domain ? null : p.domain)
                      }
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Confirm + start */}
          {totalToDelete > 0 ? (
            <div className="pv-card border-danger/40 p-4 sm:p-5">
              <div className="flex items-start gap-2 text-sm text-danger">
                <AlertIcon size={18} className="mt-0.5 shrink-0" />
                <span>
                  This permanently deletes{" "}
                  <strong>{formatNumber(totalToDelete)} inboxes</strong> across{" "}
                  <strong>{trimmed.length} domain{trimmed.length === 1 ? "" : "s"}</strong>{" "}
                  (worst warmup health first), then reconfigures + enables warmup on
                  the {formatNumber(totalKeep)} kept. This cannot be undone.
                </span>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <span className="text-sm text-muted-foreground">
                  Type <strong className="text-foreground">{totalToDelete}</strong> to
                  confirm:
                </span>
                <input
                  className="pv-input w-36 font-mono"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder={String(totalToDelete)}
                />
                <button
                  type="button"
                  className="pv-btn bg-danger text-white shadow-soft hover:brightness-110 disabled:opacity-50"
                  disabled={!confirmArmed || starting}
                  onClick={handleStart}
                >
                  {starting ? <Spinner /> : <TrashIcon size={16} />}
                  Start job — delete {formatNumber(totalToDelete)} &amp; reconfigure
                </button>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Runs in the background on the server — safe to close this tab. Track
                it in <strong>Jobs</strong> below.
              </p>
              {hasRunningJob && (
                <p className="mt-1 text-xs text-warning">
                  A job is already running. Starting another will act on the current
                  inbox counts — reload the preview first to avoid double-deleting.
                </p>
              )}
            </div>
          ) : (
            <EmptyState icon={<CheckIcon />} title="Nothing to trim">
              No domain in this workspace has more than {target} inboxes.
            </EmptyState>
          )}
        </>
      )}

      {plans && plans.length === 0 && !loading && (
        <EmptyState title="No domains found">
          This workspace has no inboxes with a parseable domain.
        </EmptyState>
      )}

      {/* Jobs */}
      <JobsPanel
        jobs={jobs}
        highlightJobId={highlightJobId}
        onAbort={handleAbortJob}
      />

      {toast && (
        <div className="fixed bottom-5 right-5 z-50 animate-fade-in">
          <div className="pv-card flex items-center gap-3 border-accent/40 px-4 py-3 shadow-card">
            <FireIcon size={16} className="text-accent" />
            <span className="text-sm font-medium">{toast}</span>
            <button
              type="button"
              onClick={() => setToast(null)}
              className="ml-1 text-muted-foreground hover:text-foreground"
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function PlanRow({
  plan,
  expanded,
  onToggle,
}: {
  plan: DomainPlan;
  expanded: boolean;
  onToggle: () => void;
}) {
  const trim = plan.toDelete > 0;
  return (
    <>
      <tr
        className={`border-b border-border/70 last:border-0 ${
          trim ? "cursor-pointer hover:bg-muted/50" : "opacity-60"
        }`}
        onClick={trim ? onToggle : undefined}
      >
        <td className="px-4 py-3 font-medium">{plan.domain}</td>
        <td className="px-4 py-3 text-right tabular-nums">{formatNumber(plan.total)}</td>
        <td
          className={`px-4 py-3 text-right tabular-nums ${
            trim ? "text-danger" : "text-muted-foreground"
          }`}
        >
          {trim ? formatNumber(plan.toDelete) : "—"}
        </td>
        <td className="px-4 py-3 text-right tabular-nums">{formatNumber(plan.keep)}</td>
        <td className="px-2 py-3 text-right text-muted-foreground">
          {trim && (
            <ChevronDownIcon
              size={14}
              className={`inline transition ${expanded ? "rotate-180" : ""}`}
            />
          )}
        </td>
      </tr>
      {expanded && trim && (
        <tr className="bg-muted/30">
          <td colSpan={5} className="px-4 py-3">
            <div className="mb-2 text-xs text-muted-foreground">
              Worst {formatNumber(plan.toDelete)} inboxes (deleted):
            </div>
            <div className="pv-scroll max-h-48 overflow-y-auto rounded-lg border border-border">
              <table className="w-full text-xs">
                <tbody>
                  {plan.deleteInboxes.map((i) => (
                    <tr key={i.id} className="border-b border-border/60 last:border-0">
                      <td className="px-3 py-1.5 font-mono">{i.email}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                        health {i.health ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Jobs panel
// ---------------------------------------------------------------------------

function JobsPanel({
  jobs,
  highlightJobId,
  onAbort,
}: {
  jobs: Remove50Job[];
  highlightJobId: string | null;
  onAbort: (id: string) => void;
}) {
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold">Jobs</h2>
      {jobs.length === 0 ? (
        <EmptyState icon={<FireIcon />} title="No jobs yet">
          Load a workspace, confirm, and start a trim — it&apos;ll appear here and
          keep running even if you close the app.
        </EmptyState>
      ) : (
        jobs.map((job) => (
          <JobCard
            key={job.id}
            job={job}
            highlight={job.id === highlightJobId}
            onAbort={onAbort}
          />
        ))
      )}
    </div>
  );
}

const STATUS_META: Record<Remove50JobStatus, { label: string; className: string }> = {
  running: { label: "Running", className: "bg-accent/10 text-accent" },
  done: { label: "Done", className: "bg-success/10 text-success" },
  aborted: { label: "Aborted", className: "bg-muted text-muted-foreground" },
  interrupted: { label: "Interrupted", className: "bg-warning/10 text-warning" },
  error: { label: "Error", className: "bg-danger/10 text-danger" },
};

function JobCard({
  job,
  highlight,
  onAbort,
}: {
  job: Remove50Job;
  highlight: boolean;
  onAbort: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const p = job.progress;
  const deleteAttempted = p.inboxesDeleted + p.inboxesSkipped + p.inboxesErrored;
  const totalUnits = p.inboxesToDelete + p.domainsTotal;
  const doneUnits = deleteAttempted + p.domainsConfigured;
  const pct =
    job.status === "done"
      ? 100
      : totalUnits > 0
        ? Math.min(100, Math.round((doneUnits / totalUnits) * 100))
        : 0;
  const status = STATUS_META[job.status];

  const phaseLabel =
    job.status !== "running"
      ? status.label
      : job.phase === "deleting"
        ? "Deleting inboxes"
        : job.phase === "configuring"
          ? "Applying warmup settings"
          : "Finishing";

  return (
    <div
      className={`pv-card p-4 sm:p-5 ${highlight ? "ring-2 ring-accent/40" : ""}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-medium ${status.className}`}
          >
            {job.status === "running" && <Spinner size={10} />} {status.label}
          </span>
          <span className="text-sm font-medium">{job.label}</span>
        </div>
        <span className="text-xs text-muted-foreground">
          {relativeTime(job.createdAt)}
        </span>
      </div>

      {/* Progress */}
      <div className="mt-3">
        <div className="mb-1.5 flex items-center justify-between text-xs text-muted-foreground">
          <span className="flex items-center gap-2">
            {job.status === "running" && <Spinner size={12} />}
            {phaseLabel}
          </span>
          <span className="tabular-nums">{pct}%</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full rounded-full transition-all duration-300 ${
              job.status === "error" ? "bg-danger" : "bg-accent"
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-4 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {formatNumber(deleteAttempted)} / {formatNumber(p.inboxesToDelete)}{" "}
            inboxes deleted
          </span>
          <span className="tabular-nums">
            {formatNumber(p.domainsConfigured)} / {formatNumber(p.domainsTotal)}{" "}
            domains reconfigured
          </span>
        </div>
      </div>

      {/* Result counts */}
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label="Inboxes deleted" value={p.inboxesDeleted} tone="success" />
        <Metric label="Domains reconfigured" value={p.domainsConfigured} tone="default" />
        <Metric
          label="Business type skipped"
          value={job.businessTypeSkipped}
          tone="muted"
        />
        <Metric
          label="Errors"
          value={job.errors.length}
          tone={job.errors.length > 0 ? "danger" : "muted"}
        />
      </div>

      {p.inboxesSkipped > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {formatNumber(p.inboxesSkipped)} already removed (skipped).
        </p>
      )}
      {job.businessTypeSkipped > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Business type “{WARMUP_SETTINGS.warmup_business_type}” was not accepted on{" "}
          {formatNumber(job.businessTypeSkipped)} domain
          {job.businessTypeSkipped === 1 ? "" : "s"} — every other warmup setting was
          still applied.
        </p>
      )}
      {job.status === "interrupted" && (
        <p className="mt-2 text-xs text-warning">
          Interrupted by a server restart — reload the preview and start again to
          finish any remaining domains.
        </p>
      )}

      {/* Actions */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {job.status === "running" && (
          <button
            type="button"
            className="pv-btn-ghost"
            onClick={() => onAbort(job.id)}
          >
            Abort
          </button>
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
        <div className="mt-3 space-y-3">
          {/* Per-domain rollup */}
          <div className="pv-scroll max-h-56 overflow-y-auto rounded-xl border border-border">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Domain</th>
                  <th className="px-3 py-2 text-right font-medium">Deleted</th>
                  <th className="px-3 py-2 text-right font-medium">Kept</th>
                  <th className="px-3 py-2 text-right font-medium">Warmup</th>
                  <th className="px-3 py-2 text-right font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {job.domains.map((d) => (
                  <tr key={d.domain} className="border-b border-border/70 last:border-0">
                    <td className="px-3 py-2 font-medium">{d.domain}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatNumber(d.deleted)} / {formatNumber(d.toDelete)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatNumber(d.keep)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {d.warmupEnabled ? (
                        <span className="text-success">on</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <DomainStatusBadge status={d.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {job.errors.length > 0 && (
            <div className="pv-scroll max-h-48 overflow-y-auto rounded-xl border border-border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Domain</th>
                    <th className="px-3 py-2 font-medium">Phase</th>
                    <th className="px-3 py-2 font-medium">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {job.errors.map((e, i) => (
                    <tr key={i} className="border-b border-border/70 last:border-0">
                      <td className="px-3 py-2 font-mono">
                        {e.email ?? e.domain}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{e.phase}</td>
                      <td className="px-3 py-2 text-danger">{e.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {job.errorsTruncated && (
                <div className="px-3 py-2 text-xs text-muted-foreground">
                  Error list truncated.
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DomainStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    pending: { label: "Pending", cls: "text-muted-foreground" },
    deleting: { label: "Deleting", cls: "text-accent" },
    configuring: { label: "Configuring", cls: "text-accent" },
    done: { label: "Done", cls: "text-success" },
    partial: { label: "Partial", cls: "text-warning" },
    error: { label: "Error", cls: "text-danger" },
  };
  const m = map[status] ?? map.pending;
  return <span className={m.cls}>{m.label}</span>;
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "default" | "success" | "danger" | "muted";
}) {
  const color =
    tone === "success"
      ? "text-success"
      : tone === "danger"
        ? "text-danger"
        : tone === "muted"
          ? "text-muted-foreground"
          : "text-foreground";
  return (
    <div>
      <div className={`text-lg font-semibold tabular-nums ${color}`}>
        {formatNumber(value)}
      </div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.round(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(ts).toLocaleDateString();
}

function isAbort(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

function errMessage(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
