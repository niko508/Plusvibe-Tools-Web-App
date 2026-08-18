"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Workspace, CampaignSummary } from "@/lib/plusvibe-types";
import {
  fetchWorkspaces,
  fetchCampaigns,
  removeOpeningLine,
  ApiClientError,
  type OpeningLinePlan,
} from "@/lib/api-client";
import { useApiKey } from "@/lib/use-api-key";
import { formatNumber } from "@/lib/format";
import { ConnectPrompt } from "@/components/connect-prompt";
import { StatCard } from "@/components/stat-card";
import { Spinner, EmptyState } from "@/components/ui";
import {
  ScissorsIcon,
  AlertIcon,
  RefreshIcon,
  ChevronDownIcon,
  CheckIcon,
} from "@/components/icons";

// The API has no DRAFT status — a never-launched campaign comes back INACTIVE,
// which the `status` query filter won't accept, so bucket client-side.
type Bucket = "active" | "draft" | "paused" | "completed" | "archived";

function statusBucket(status: string): Bucket {
  const s = (status ?? "").toUpperCase();
  if (s === "ACTIVE" || s === "RUNNING") return "active";
  if (s === "PAUSED") return "paused";
  if (s === "COMPLETED") return "completed";
  if (s === "ARCHIVED") return "archived";
  return "draft";
}

const BUCKET_LABEL: Record<Bucket, string> = {
  active: "Active",
  draft: "Draft",
  paused: "Paused",
  completed: "Completed",
  archived: "Archived",
};

const HIDDEN_ORDER: Bucket[] = ["paused", "completed", "archived"];

export function RemoveOpeningLineTool() {
  const { hasKey, ready } = useApiKey();

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(false);
  const [workspaceId, setWorkspaceId] = useState("");

  const [campaigns, setCampaigns] = useState<CampaignSummary[] | null>(null);
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [campaignId, setCampaignId] = useState("");

  const [plan, setPlan] = useState<OpeningLinePlan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [showSubject, setShowSubject] = useState(false);

  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<OpeningLinePlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const applyLock = useRef(false);

  // --- Workspaces ----------------------------------------------------------
  const loadWorkspaces = useCallback(async () => {
    setWorkspacesLoading(true);
    setError(null);
    try {
      const res = await fetchWorkspaces();
      const list = res.workspaces ?? [];
      setWorkspaces(list);
      setWorkspaceId((prev) => prev || list[0]?._id || "");
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
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  // --- Campaigns -----------------------------------------------------------
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    const controller = new AbortController();
    setCampaignsLoading(true);
    setCampaigns(null);
    setCampaignId("");
    setPlan(null);
    setResult(null);
    setError(null);
    fetchCampaigns({ workspace_id: workspaceId }, controller.signal)
      .then((res) => {
        if (!cancelled) setCampaigns(res.campaigns ?? []);
      })
      .catch((err) => {
        if (!cancelled && !isAbort(err)) setError(errMessage(err));
      })
      .finally(() => {
        if (!cancelled) setCampaignsLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [workspaceId]);

  const allCampaigns = useMemo(
    () => (campaigns ?? []).filter((c) => c.campaignType !== "subseq"),
    [campaigns]
  );

  const visibleCampaigns = useMemo(() => {
    if (showAll) return allCampaigns;
    return allCampaigns.filter((c) => {
      const b = statusBucket(c.status);
      return b === "active" || b === "draft";
    });
  }, [allCampaigns, showAll]);

  const hiddenCount = allCampaigns.length - visibleCampaigns.length;

  const hiddenBreakdown = useMemo(() => {
    const counts = new Map<Bucket, number>();
    for (const c of allCampaigns) {
      const b = statusBucket(c.status);
      if (b === "active" || b === "draft") continue;
      counts.set(b, (counts.get(b) ?? 0) + 1);
    }
    return HIDDEN_ORDER.filter((b) => counts.has(b)).map(
      (b) => `${counts.get(b)} ${BUCKET_LABEL[b].toLowerCase()}`
    );
  }, [allCampaigns]);

  // --- Preview (dry run) ---------------------------------------------------
  const loadPlan = useCallback(
    async (id: string) => {
      if (!workspaceId || !id) return;
      setPlanLoading(true);
      setPlan(null);
      setResult(null);
      setError(null);
      try {
        const p = await removeOpeningLine({
          workspace_id: workspaceId,
          campaign_id: id,
          dryRun: true,
        });
        setPlan(p);
      } catch (err) {
        setError(errMessage(err));
      } finally {
        setPlanLoading(false);
      }
    },
    [workspaceId]
  );

  useEffect(() => {
    if (campaignId) void loadPlan(campaignId);
  }, [campaignId, loadPlan]);

  async function handleRefresh() {
    if (!workspaceId || refreshing) return;
    setRefreshing(true);
    setError(null);
    try {
      const res = await fetchCampaigns({ workspace_id: workspaceId });
      const list = res.campaigns ?? [];
      setCampaigns(list);
      if (campaignId && list.some((c) => c.id === campaignId)) {
        await loadPlan(campaignId);
      } else if (campaignId) {
        setCampaignId("");
        setPlan(null);
      }
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setRefreshing(false);
    }
  }

  // --- Apply ---------------------------------------------------------------
  const nothingToDo =
    !!plan &&
    plan.totals.subjectsChanged === 0 &&
    plan.totals.bodiesChanged === 0;

  async function handleApply() {
    if (!plan || !campaignId || nothingToDo || applying) return;
    if (applyLock.current) return;
    applyLock.current = true;
    setApplying(true);
    setError(null);
    setResult(null);
    try {
      const res = await removeOpeningLine({
        workspace_id: workspaceId,
        campaign_id: campaignId,
      });
      setResult(res);
      if (res.applied && res.verified) {
        setToast("Personalized opening line removed from the campaign");
      }
      await loadPlan(campaignId);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      applyLock.current = false;
      setApplying(false);
    }
  }

  // --- Render --------------------------------------------------------------
  if (!ready) return <div className="pv-card h-40 animate-pulse" />;
  if (!hasKey) return <ConnectPrompt onConnected={loadWorkspaces} />;

  return (
    <div className="space-y-5">
      {/* Workspace + campaign */}
      <div className="pv-card space-y-4 p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row">
          <div className="min-w-[200px] flex-1">
            <label className="mb-1.5 block text-sm font-medium">Workspace</label>
            <Select
              value={workspaceId}
              disabled={workspacesLoading || workspaces.length === 0}
              onChange={setWorkspaceId}
            >
              {workspacesLoading && <option>Loading…</option>}
              {!workspacesLoading &&
                workspaces.map((w) => (
                  <option key={w._id} value={w._id}>
                    {w.name}
                  </option>
                ))}
            </Select>
          </div>
          <div className="min-w-[240px] flex-[1.4]">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <label className="block text-sm font-medium">Campaign</label>
              {campaignsLoading && <Spinner size={12} />}
            </div>
            <Select
              value={campaignId}
              disabled={campaignsLoading || visibleCampaigns.length === 0}
              onChange={setCampaignId}
            >
              <option value="">
                {campaignsLoading
                  ? "Loading campaigns…"
                  : visibleCampaigns.length === 0
                    ? "No campaigns"
                    : "Select a campaign…"}
              </option>
              {visibleCampaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — {BUCKET_LABEL[statusBucket(c.status)]}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-accent"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
            />
            Show all campaigns
            {allCampaigns.length > 0 && (
              <span>
                · {formatNumber(allCampaigns.length)} in this workspace
                {hiddenCount > 0 &&
                  !showAll &&
                  ` (${hiddenBreakdown.join(", ")} hidden)`}
              </span>
            )}
          </label>
          <button
            type="button"
            className="pv-btn-ghost text-xs"
            onClick={handleRefresh}
            disabled={!workspaceId || refreshing || campaignsLoading}
            title="Re-read the campaign list and the selected campaign from Plusvibe"
          >
            {refreshing ? <Spinner size={14} /> : <RefreshIcon size={14} />}
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          <AlertIcon size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {planLoading && (
        <div className="pv-card flex items-center gap-3 p-4 text-sm text-muted-foreground">
          <Spinner size={14} />
          Reading the campaign and working out what would change…
        </div>
      )}

      {/* Preview */}
      {plan && !planLoading && (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatCard label="Variations" value={formatNumber(plan.totals.variations)} />
            <StatCard
              label="Subjects to unwrap"
              value={formatNumber(plan.totals.subjectsChanged)}
            />
            <StatCard
              label="Bodies to clean"
              value={formatNumber(plan.totals.bodiesChanged)}
            />
            <StatCard
              label="Opening lines removed"
              value={formatNumber(plan.totals.openingLinesRemoved)}
            />
          </div>

          {nothingToDo ? (
            <EmptyState icon={<CheckIcon />} title="Nothing to change">
              No variation on this campaign has a{" "}
              <span className="font-mono text-xs">{"{{fallback|…}}"}</span> subject
              or an <span className="font-mono text-xs">{"{{opening_line}}"}</span>{" "}
              in the body — it&apos;s already clean.
            </EmptyState>
          ) : (
            <>
              {/* Subject before/after */}
              {plan.subjectSample && (
                <div className="pv-card overflow-hidden">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-sm font-medium hover:bg-muted/40"
                    onClick={() => setShowSubject((v) => !v)}
                  >
                    <span>Subject line — before and after</span>
                    <ChevronDownIcon
                      size={16}
                      className={`shrink-0 text-muted-foreground transition ${
                        showSubject ? "rotate-180" : ""
                      }`}
                    />
                  </button>
                  {showSubject && (
                    <div className="space-y-3 border-t border-border px-4 py-3">
                      <div>
                        <div className="mb-1 text-xs font-medium text-muted-foreground">
                          Before
                        </div>
                        <div className="pv-scroll max-h-32 overflow-y-auto rounded-lg border border-border bg-muted/40 px-3 py-2 font-mono text-[11px] leading-relaxed">
                          {plan.subjectSample.before}
                        </div>
                      </div>
                      <div>
                        <div className="mb-1 text-xs font-medium text-success">
                          After
                        </div>
                        <div className="pv-scroll max-h-32 overflow-y-auto rounded-lg border border-success/40 bg-success/10 px-3 py-2 font-mono text-[11px] leading-relaxed">
                          {plan.subjectSample.after}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Per-variation table */}
              <div className="pv-card overflow-hidden">
                <div className="border-b border-border bg-muted/40 px-4 py-2 text-xs font-medium">
                  What changes, variation by variation
                </div>
                <div className="pv-scroll max-h-72 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border text-left text-muted-foreground">
                        <th className="px-4 py-2 font-medium">Step</th>
                        <th className="px-4 py-2 font-medium">Variation</th>
                        <th className="px-4 py-2 font-medium">Subject</th>
                        <th className="px-4 py-2 font-medium">Body</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.rows.map((r) => (
                        <tr
                          key={`${r.step}-${r.variation}`}
                          className="border-b border-border/70 last:border-0"
                        >
                          <td className="px-4 py-2 tabular-nums text-muted-foreground">
                            {r.step}
                          </td>
                          <td className="px-4 py-2 font-mono">{r.variation}</td>
                          <td className="px-4 py-2">
                            {r.subjectChanged ? (
                              <span className="text-success">unwrapped</span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="px-4 py-2">
                            {r.bodyChanged ? (
                              <span className="text-success">
                                opening line removed
                              </span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Apply */}
              <div className="pv-card p-4 sm:p-5">
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    className="pv-btn-primary"
                    disabled={applying}
                    onClick={handleApply}
                  >
                    {applying ? <Spinner /> : <ScissorsIcon size={16} />}
                    Remove opening line from{" "}
                    {formatNumber(plan.totals.variations)} variation
                    {plan.totals.variations === 1 ? "" : "s"}
                  </button>
                  <span className="text-xs text-muted-foreground">
                    Variations, letters and the rest of the copy stay exactly as
                    they are.
                  </span>
                </div>
              </div>
            </>
          )}
        </>
      )}

      {/* Result */}
      {result && (
        <div
          className={`pv-card p-4 sm:p-5 ${
            result.verified ? "border-success/40" : "border-warning/40"
          }`}
        >
          <div className="flex items-start gap-2">
            {result.verified ? (
              <CheckIcon size={18} className="mt-0.5 shrink-0 text-success" />
            ) : (
              <AlertIcon size={18} className="mt-0.5 shrink-0 text-warning" />
            )}
            <div className="text-sm">
              {result.verified ? (
                <>
                  Unwrapped{" "}
                  <strong>
                    {formatNumber(result.totals.subjectsChanged)} subject
                    {result.totals.subjectsChanged === 1 ? "" : "s"}
                  </strong>{" "}
                  and removed the opening line from{" "}
                  <strong>
                    {formatNumber(result.totals.bodiesChanged)} bod
                    {result.totals.bodiesChanged === 1 ? "y" : "ies"}
                  </strong>
                  . Verified — nothing left to strip.
                </>
              ) : (
                <>
                  The write went through, but {formatNumber(result.leftover ?? 0)}{" "}
                  variation
                  {(result.leftover ?? 0) === 1 ? "" : "s"} still carry a fallback
                  subject or an opening line. Check the campaign in Plusvibe.
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {campaigns && campaigns.length === 0 && !campaignsLoading && (
        <EmptyState icon={<ScissorsIcon />} title="No campaigns">
          This workspace has no campaigns yet.
        </EmptyState>
      )}

      {toast && (
        <div className="fixed bottom-5 right-5 z-50 animate-fade-in">
          <div className="flex items-center gap-3 rounded-xl border border-success/40 bg-success/15 px-4 py-3 shadow-card backdrop-blur">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-success/20 text-success">
              <CheckIcon size={14} />
            </span>
            <span className="text-sm font-medium text-success">{toast}</span>
            <button
              type="button"
              onClick={() => setToast(null)}
              className="ml-1 text-success/70 transition hover:text-success"
              aria-label="Dismiss"
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

function Select({
  value,
  onChange,
  disabled,
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="relative">
      <select
        className="pv-input appearance-none pr-9"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
      <ChevronDownIcon
        size={16}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  );
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
