"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Workspace, EmailAccount } from "@/lib/plusvibe-types";
import {
  fetchWorkspaces,
  fetchAccounts,
  deleteAccount,
  updateWarmupSettings,
  setWarmupStatus,
  ApiClientError,
  type WarmupSettings,
} from "@/lib/api-client";
import { useApiKey } from "@/lib/use-api-key";
import { formatNumber } from "@/lib/format";
import { mapPool } from "@/lib/concurrency";
import { domainFromEmail } from "@/lib/format";
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

type RunStatus = "pending" | "deleting" | "configuring" | "done" | "error";

interface RunRow {
  domain: string;
  status: RunStatus;
  deleted: number;
  toDelete: number;
  configured: boolean;
  businessTypeSkipped: boolean;
  error?: string;
}

const CONCURRENCY = 3;
const SPACING = 240;

export function Remove50Tool() {
  const { hasKey, ready } = useApiKey();

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(false);
  const [workspaceId, setWorkspaceId] = useState("");
  const [target] = useState(DEFAULT_TARGET);

  const [loading, setLoading] = useState(false);
  const [plans, setPlans] = useState<DomainPlan[] | null>(null);
  const [loadedForWs, setLoadedForWs] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const [confirmText, setConfirmText] = useState("");
  const [running, setRunning] = useState(false);
  const [runRows, setRunRows] = useState<RunRow[]>([]);
  const [progress, setProgress] = useState({ label: "", done: 0, total: 0 });
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // --- Workspaces ----------------------------------------------------------
  const loadWorkspaces = useCallback(async () => {
    setWorkspacesLoading(true);
    setError(null);
    try {
      const res = await fetchWorkspaces();
      const list = res.workspaces ?? [];
      setWorkspaces(list);
      if (list.length && !workspaceId) {
        const warmup = list.find(
          (w) => w.name.trim().toLowerCase() === DEFAULT_EXCLUDED_WORKSPACE
        );
        setWorkspaceId(warmup?._id ?? list[0]._id);
      }
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setWorkspacesLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (ready && hasKey) void loadWorkspaces();
  }, [ready, hasKey, loadWorkspaces]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(t);
  }, [toast]);

  // --- Load + build plans --------------------------------------------------
  async function loadPlans() {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    setPlans(null);
    setRunRows([]);
    setDone(false);
    setConfirmText("");
    try {
      const res = await fetchAccounts({ workspace_id: workspaceId });
      const byDomain = new Map<string, InboxLite[]>();
      for (const a of res.accounts ?? []) {
        const domain = domainFromEmail(a.email);
        if (!domain || !a.id) continue;
        const inbox: InboxLite = {
          id: a.id,
          email: a.email,
          health: typeof a.warmup_health === "number" ? a.warmup_health : null,
          warmupActive: (a.warmup_status ?? "").toUpperCase() === "ACTIVE",
        };
        const arr = byDomain.get(domain);
        if (arr) arr.push(inbox);
        else byDomain.set(domain, [inbox]);
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
      // Domains needing trimming first, then by size.
      built.sort((a, b) => b.toDelete - a.toDelete || b.total - a.total);
      setPlans(built);
      setLoadedForWs(workspaceId);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setLoading(false);
    }
  }

  // --- Derived -------------------------------------------------------------
  const trimmed = (plans ?? []).filter((p) => p.toDelete > 0);
  const totalToDelete = trimmed.reduce((s, p) => s + p.toDelete, 0);
  const totalKeep = trimmed.reduce((s, p) => s + p.keep, 0);
  const confirmArmed =
    confirmText.trim() === String(totalToDelete) ||
    confirmText.trim().toUpperCase() === "DELETE";

  // --- Run -----------------------------------------------------------------
  async function handleRun() {
    if (!plans || totalToDelete === 0) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;

    const rows: RunRow[] = trimmed.map((p) => ({
      domain: p.domain,
      status: "pending",
      deleted: 0,
      toDelete: p.toDelete,
      configured: false,
      businessTypeSkipped: false,
    }));
    setRunRows(rows);
    setRunning(true);
    setDone(false);
    setError(null);
    setToast(null);

    let deletedTotal = 0;
    let configuredDomains = 0;
    let errorCount = 0;

    try {
      // Phase 1 — delete the worst inboxes across all trimmed domains.
      const deleteTasks = trimmed.flatMap((p) =>
        p.deleteInboxes.map((inbox) => ({ domain: p.domain, inbox }))
      );
      setProgress({ label: "Deleting inboxes", done: 0, total: deleteTasks.length });
      await mapPool(
        deleteTasks,
        async ({ domain, inbox }) => {
          updateRun(setRunRows, domain, { status: "deleting" });
          try {
            await deleteAccount(
              { workspace_id: workspaceId, email: inbox.email },
              signal
            );
            deletedTotal += 1;
            bumpDeleted(setRunRows, domain);
          } catch (err) {
            if (isAbort(err)) throw err;
            errorCount += 1;
            updateRun(setRunRows, domain, {
              status: "error",
              error: errMessage(err),
            });
          } finally {
            if (!signal.aborted) {
              setProgress((p) => ({ ...p, done: p.done + 1 }));
            }
          }
        },
        { concurrency: CONCURRENCY, minSpacingMs: SPACING, signal }
      );

      // Phase 2 — apply warmup settings + enable warmup on the kept inboxes.
      setProgress({
        label: "Applying warmup settings",
        done: 0,
        total: trimmed.length,
      });
      await mapPool(
        trimmed,
        async (p) => {
          updateRun(setRunRows, p.domain, { status: "configuring" });
          const keepIds = p.keepInboxes.map((i) => i.id);
          try {
            const skipped = await applyWarmup(workspaceId, keepIds, signal);
            await setWarmupStatus(
              { workspace_id: workspaceId, ids: keepIds, warmup_status: "ACTIVE" },
              signal
            );
            configuredDomains += 1;
            updateRun(setRunRows, p.domain, {
              status: "done",
              configured: true,
              businessTypeSkipped: skipped,
            });
          } catch (err) {
            if (isAbort(err)) throw err;
            errorCount += 1;
            updateRun(setRunRows, p.domain, {
              status: "error",
              error: errMessage(err),
            });
          } finally {
            if (!signal.aborted) {
              setProgress((p2) => ({ ...p2, done: p2.done + 1 }));
            }
          }
        },
        { concurrency: CONCURRENCY, minSpacingMs: SPACING, signal }
      );

      setDone(true);
      const msg =
        errorCount > 0
          ? `Trimmed ${configuredDomains} domains · ${formatNumber(
              deletedTotal
            )} inboxes deleted · ${errorCount} error${errorCount === 1 ? "" : "s"}`
          : `Done — ${formatNumber(deletedTotal)} inboxes deleted, ${configuredDomains} domains reconfigured 🎉`;
      setToast(msg);
      showNotification("Remove 50 — done", msg);
      // Reload plans so the preview reflects the new state.
      void loadPlans();
    } catch (err) {
      if (!isAbort(err)) setError(errMessage(err));
    } finally {
      if (!controller.signal.aborted) setRunning(false);
    }
  }

  function abortRun() {
    abortRef.current?.abort();
    setRunning(false);
  }

  // --- Render --------------------------------------------------------------
  if (!ready) return <div className="pv-card h-40 animate-pulse" />;
  if (!hasKey) return <ConnectPrompt onConnected={loadWorkspaces} />;

  const results = summarizeRun(runRows);

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
                  setRunRows([]);
                  setDone(false);
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
          <button
            type="button"
            className="pv-btn-primary"
            onClick={loadPlans}
            disabled={loading || !workspaceId}
          >
            {loading ? <Spinner /> : <RefreshIcon size={16} />}
            {loadedForWs === workspaceId ? "Reload" : "Load & preview"}
          </button>
        </div>
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

          {/* Confirm + run */}
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
                {running && (
                  <button type="button" className="pv-btn-ghost" onClick={abortRun}>
                    Abort
                  </button>
                )}
                <button
                  type="button"
                  className="pv-btn bg-danger text-white shadow-soft hover:brightness-110 disabled:opacity-50"
                  disabled={!confirmArmed || running}
                  onClick={handleRun}
                >
                  {running ? <Spinner /> : <TrashIcon size={16} />}
                  Delete {formatNumber(totalToDelete)} &amp; reconfigure
                </button>
              </div>
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

      {/* Run progress + results */}
      {(running || done) && runRows.length > 0 && (
        <div className="pv-card p-4 sm:p-5">
          <div className="mb-1.5 flex items-center justify-between text-xs text-muted-foreground">
            <span className="flex items-center gap-2">
              {running && <Spinner size={12} />}
              {done ? "Done" : progress.label + "…"}
            </span>
            <span className="tabular-nums">
              {progress.done} / {progress.total}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-accent transition-all duration-300"
              style={{
                width: `${
                  progress.total > 0
                    ? Math.round((progress.done / progress.total) * 100)
                    : 0
                }%`,
              }}
            />
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="Inboxes deleted" value={results.deleted} />
            <Metric label="Domains reconfigured" value={results.configured} />
            <Metric label="Business type skipped" value={results.btSkipped} muted />
            <Metric label="Errors" value={results.errors} danger={results.errors > 0} />
          </div>

          {results.errorRows.length > 0 && (
            <div className="pv-scroll mt-3 max-h-40 overflow-y-auto rounded-xl border border-border text-xs">
              {results.errorRows.map((r) => (
                <div
                  key={r.domain}
                  className="flex justify-between gap-3 border-b border-border/70 px-3 py-2 last:border-0"
                >
                  <span className="font-medium">{r.domain}</span>
                  <span className="text-danger">{r.error}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

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

function Metric({
  label,
  value,
  danger,
  muted,
}: {
  label: string;
  value: number;
  danger?: boolean;
  muted?: boolean;
}) {
  return (
    <div>
      <div
        className={`text-lg font-semibold tabular-nums ${
          danger ? "text-danger" : muted ? "text-muted-foreground" : "text-foreground"
        }`}
      >
        {formatNumber(value)}
      </div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------

// Applies the warmup settings; if the API rejects the business type, retries
// once without it so the rest still applies. Returns whether it was skipped.
async function applyWarmup(
  workspaceId: string,
  ids: string[],
  signal: AbortSignal
): Promise<boolean> {
  try {
    await updateWarmupSettings(
      { workspace_id: workspaceId, ids, settings: WARMUP_SETTINGS },
      signal
    );
    return false;
  } catch (err) {
    if (isAbort(err)) throw err;
    const { warmup_business_type, ...rest } = WARMUP_SETTINGS;
    void warmup_business_type;
    await updateWarmupSettings(
      { workspace_id: workspaceId, ids, settings: rest as WarmupSettings },
      signal
    );
    return true;
  }
}

function updateRun(
  setRows: React.Dispatch<React.SetStateAction<RunRow[]>>,
  domain: string,
  patch: Partial<RunRow>
) {
  setRows((prev) => prev.map((r) => (r.domain === domain ? { ...r, ...patch } : r)));
}

function bumpDeleted(
  setRows: React.Dispatch<React.SetStateAction<RunRow[]>>,
  domain: string
) {
  setRows((prev) =>
    prev.map((r) => (r.domain === domain ? { ...r, deleted: r.deleted + 1 } : r))
  );
}

function summarizeRun(rows: RunRow[]) {
  let deleted = 0;
  let configured = 0;
  let btSkipped = 0;
  let errors = 0;
  const errorRows: RunRow[] = [];
  for (const r of rows) {
    deleted += r.deleted;
    if (r.configured) configured += 1;
    if (r.businessTypeSkipped) btSkipped += 1;
    if (r.status === "error") {
      errors += 1;
      errorRows.push(r);
    }
  }
  return { deleted, configured, btSkipped, errors, errorRows };
}

function showNotification(title: string, body: string) {
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(title, { body });
    } else if (
      typeof Notification !== "undefined" &&
      Notification.permission === "default"
    ) {
      void Notification.requestPermission();
    }
  } catch {
    // ignore
  }
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
