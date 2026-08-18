"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Workspace, CampaignSummary } from "@/lib/plusvibe-types";
import {
  fetchWorkspaces,
  fetchCampaigns,
  fetchLeadsPreview,
  moveLeads,
  ApiClientError,
  type LeadsPreview,
  type MoveLeadsResult,
} from "@/lib/api-client";
import { useApiKey } from "@/lib/use-api-key";
import { formatNumber } from "@/lib/format";
import { ConnectPrompt } from "@/components/connect-prompt";
import { StatCard } from "@/components/stat-card";
import { Spinner, EmptyState } from "@/components/ui";
import {
  MoveIcon,
  AlertIcon,
  RefreshIcon,
  ChevronDownIcon,
  CheckIcon,
} from "@/components/icons";

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

export function MoveLeadsTool() {
  const { hasKey, ready } = useApiKey();

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(false);
  const [workspaceId, setWorkspaceId] = useState("");

  const [campaigns, setCampaigns] = useState<CampaignSummary[] | null>(null);
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const [sourceId, setSourceId] = useState("");
  const [destId, setDestId] = useState("");
  const [count, setCount] = useState("100");

  const [preview, setPreview] = useState<LeadsPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [moving, setMoving] = useState(false);
  const [result, setResult] = useState<MoveLeadsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const moveLock = useRef(false);

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
    setSourceId("");
    setDestId("");
    setPreview(null);
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

  // --- Source preview ------------------------------------------------------
  const loadPreview = useCallback(
    async (id: string) => {
      if (!workspaceId || !id) return;
      setPreviewLoading(true);
      setPreview(null);
      setResult(null);
      setError(null);
      try {
        const p = await fetchLeadsPreview({
          workspace_id: workspaceId,
          campaign_id: id,
        });
        setPreview(p);
      } catch (err) {
        setError(errMessage(err));
      } finally {
        setPreviewLoading(false);
      }
    },
    [workspaceId]
  );

  useEffect(() => {
    if (sourceId) void loadPreview(sourceId);
    else setPreview(null);
  }, [sourceId, loadPreview]);

  async function handleRefresh() {
    if (!workspaceId || refreshing) return;
    setRefreshing(true);
    setError(null);
    try {
      const res = await fetchCampaigns({ workspace_id: workspaceId });
      const list = res.campaigns ?? [];
      setCampaigns(list);
      if (sourceId && list.some((c) => c.id === sourceId)) {
        await loadPreview(sourceId);
      } else if (sourceId) {
        setSourceId("");
        setPreview(null);
      }
      if (destId && !list.some((c) => c.id === destId)) setDestId("");
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setRefreshing(false);
    }
  }

  // --- Move ----------------------------------------------------------------
  const n = Math.floor(Number(count));
  const validCount = Number.isFinite(n) && n >= 1;
  const sameCampaign = !!sourceId && sourceId === destId;
  const available = preview?.available ?? 0;
  const willMove = preview ? Math.min(n || 0, available) : n || 0;
  const canMove =
    !!sourceId && !!destId && !sameCampaign && validCount && !moving;

  async function handleMove() {
    if (!canMove) return;
    if (moveLock.current) return;
    moveLock.current = true;
    setMoving(true);
    setError(null);
    setResult(null);
    try {
      const res = await moveLeads({
        workspace_id: workspaceId,
        source_campaign_id: sourceId,
        destination_campaign_id: destId,
        count: n,
      });
      setResult(res);
      if (res.complete && res.deletedFromSource > 0) {
        setToast(
          `${formatNumber(res.deletedFromSource)} lead${
            res.deletedFromSource === 1 ? "" : "s"
          } moved to the destination campaign`
        );
      }
      await loadPreview(sourceId);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      moveLock.current = false;
      setMoving(false);
    }
  }

  const nameOf = (id: string) =>
    allCampaigns.find((c) => c.id === id)?.name ?? "";

  // --- Render --------------------------------------------------------------
  if (!ready) return <div className="pv-card h-40 animate-pulse" />;
  if (!hasKey) return <ConnectPrompt onConnected={loadWorkspaces} />;

  return (
    <div className="space-y-5">
      {/* Workspace */}
      <div className="pv-card space-y-4 p-4 sm:p-5">
        <div className="max-w-sm">
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

        {/* Source → destination */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="min-w-[200px] flex-1">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <label className="block text-sm font-medium">Source campaign</label>
              {campaignsLoading && <Spinner size={12} />}
            </div>
            <Select
              value={sourceId}
              disabled={campaignsLoading || visibleCampaigns.length === 0}
              onChange={setSourceId}
            >
              <option value="">
                {campaignsLoading ? "Loading…" : "Select a campaign…"}
              </option>
              {visibleCampaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — {BUCKET_LABEL[statusBucket(c.status)]}
                </option>
              ))}
            </Select>
          </div>

          <div className="hidden pb-2.5 text-muted-foreground sm:block">
            <MoveIcon size={18} />
          </div>

          <div className="min-w-[200px] flex-1">
            <label className="mb-1.5 block text-sm font-medium">
              Destination campaign
            </label>
            <Select
              value={destId}
              disabled={campaignsLoading || visibleCampaigns.length === 0}
              onChange={setDestId}
            >
              <option value="">
                {campaignsLoading ? "Loading…" : "Select a campaign…"}
              </option>
              {visibleCampaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — {BUCKET_LABEL[statusBucket(c.status)]}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium">
              Leads to move
            </label>
            <input
              type="number"
              min={1}
              className="pv-input w-32 tabular-nums"
              value={count}
              onChange={(e) => setCount(e.target.value)}
            />
          </div>
        </div>

        {sameCampaign && (
          <p className="text-xs text-danger">
            Source and destination must be different campaigns.
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-accent"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
            />
            Show all campaigns
            {allCampaigns.length > 0 && (
              <span>· {formatNumber(allCampaigns.length)} in this workspace</span>
            )}
          </label>
          <button
            type="button"
            className="pv-btn-ghost text-xs"
            onClick={handleRefresh}
            disabled={!workspaceId || refreshing || campaignsLoading}
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

      {previewLoading && (
        <div className="pv-card flex items-center gap-3 p-4 text-sm text-muted-foreground">
          <Spinner size={14} />
          Counting leads in the source campaign…
        </div>
      )}

      {/* Preview */}
      {preview && !previewLoading && (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <StatCard
              label="Leads in source"
              value={formatNumber(preview.available)}
            />
            <StatCard label="Will move" value={formatNumber(willMove)} />
            <StatCard
              label="Left in source"
              value={formatNumber(Math.max(0, preview.available - willMove))}
            />
          </div>

          {preview.available === 0 && (
            <EmptyState title="No leads to move">
              The source campaign has no leads.
            </EmptyState>
          )}

          {/* What travels with each lead */}
          {preview.sample && (
            <div className="pv-card p-4 sm:p-5">
              <div className="text-sm font-medium">
                What travels with each lead
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                From {formatNumber(preview.sample.sampled)} real lead
                {preview.sample.sampled === 1 ? "" : "s"} in the source campaign
                — check your personalization variables are listed before moving
                anything.
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <div className="mb-1 text-xs font-medium text-muted-foreground">
                    Standard fields
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {preview.sample.topLevelFields.map((f) => (
                      <span
                        key={f}
                        className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px]"
                      >
                        {f}
                      </span>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-xs font-medium text-muted-foreground">
                    Custom variables
                  </div>
                  {preview.sample.customVariables.length > 0 ? (
                    <div className="space-y-1">
                      {preview.sample.customVariables.map((f) => (
                        <div
                          key={f.name}
                          className="flex items-center justify-between gap-3 text-[11px]"
                        >
                          <span className="rounded-md bg-cyan-500/10 px-1.5 py-0.5 font-mono text-cyan-600 dark:text-cyan-400">
                            {f.name}
                          </span>
                          <span className="text-muted-foreground">
                            on {f.count}/{preview.sample!.sampled}
                            {f.filled < f.count && (
                              <> · {f.filled} with a value</>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-warning">
                      None found on this lead. If your copy relies on
                      personalization like{" "}
                      <span className="font-mono">{"{{opening_line}}"}</span>,
                      check a moved lead in the destination before moving more.
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Run */}
          {preview.available > 0 && (
            <div className="pv-card border-warning/40 p-4 sm:p-5">
              <div className="flex items-start gap-2 text-sm">
                <AlertIcon size={18} className="mt-0.5 shrink-0 text-warning" />
                <span>
                  Leads are added to{" "}
                  <strong>{nameOf(destId) || "the destination"}</strong> first
                  and only removed from{" "}
                  <strong>{nameOf(sourceId) || "the source"}</strong> once that
                  is confirmed. Removal from the source can&apos;t be undone, and
                  a lead&apos;s progress in the source campaign doesn&apos;t
                  carry over.
                </span>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  className="pv-btn-primary"
                  disabled={!canMove}
                  onClick={handleMove}
                >
                  {moving ? <Spinner /> : <MoveIcon size={16} />}
                  Move {formatNumber(willMove)} lead
                  {willMove === 1 ? "" : "s"}
                </button>
                {n > available && available > 0 && (
                  <span className="text-xs text-muted-foreground">
                    Only {formatNumber(available)} available — that&apos;s all
                    that will move.
                  </span>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* Result */}
      {result && (
        <div
          className={`pv-card p-4 sm:p-5 ${
            result.complete ? "border-success/40" : "border-danger/40"
          }`}
        >
          <div className="flex items-start gap-2">
            {result.complete ? (
              <CheckIcon size={18} className="mt-0.5 shrink-0 text-success" />
            ) : (
              <AlertIcon size={18} className="mt-0.5 shrink-0 text-danger" />
            )}
            <div className="text-sm">
              Moved{" "}
              <strong>
                {formatNumber(result.deletedFromSource)} lead
                {result.deletedFromSource === 1 ? "" : "s"}
              </strong>
              {result.alreadyInDestination > 0 && (
                <>
                  {" "}
                  ({formatNumber(result.alreadyInDestination)} were already in
                  the destination)
                </>
              )}
              .
              {!result.complete && (
                <div className="mt-1 text-danger">
                  The run stopped early — see below.
                </div>
              )}
            </div>
          </div>
          {result.errors.length > 0 && (
            <div className="mt-3 space-y-2">
              {result.errors.map((e, i) => (
                <div
                  key={i}
                  className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
                >
                  {e}
                </div>
              ))}
            </div>
          )}
        </div>
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
