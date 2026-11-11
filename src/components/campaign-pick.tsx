"use client";

// Workspace + campaign multi-pick with each ticked campaign's not-contacted
// count, shared by the Export and Remove tabs of Export/Remove Not Contacted Leads.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CampaignSummary, Workspace } from "@/lib/plusvibe-types";
import { ApiClientError, fetchCampaigns, fetchLeadsPreview, fetchWorkspaces } from "@/lib/api-client";
import { formatNumber } from "@/lib/format";
import { Spinner } from "@/components/ui";
import { ChevronDownIcon } from "@/components/icons";

export const errMessage = (err: unknown) => (err instanceof ApiClientError || err instanceof Error ? err.message : "Something went wrong.");

export type Count = number | "loading" | "error";

/**
 * The pick's state. `onChange` runs whenever the workspace or the ticked
 * campaigns change, so a tool can drop results that belonged to the old pick.
 */
export function useCampaignPick(opts: { enabled: boolean; onChange?: () => void; onError: (message: string) => void }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [ws, setWs] = useState("");
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  /** Not-contacted leads per campaign, read when it is ticked. */
  const [counts, setCounts] = useState<Record<string, Count>>({});
  /** Counts are read one after another, so ticking many at once stays under Plusvibe's rate limit. */
  const countQueue = useRef<Promise<void>>(Promise.resolve());
  const onChange = useRef(opts.onChange);
  onChange.current = opts.onChange;
  const onError = useRef(opts.onError);
  onError.current = opts.onError;

  const loadWorkspaces = useCallback(async () => {
    try {
      setWorkspaces((await fetchWorkspaces()).workspaces ?? []);
    } catch (err) {
      onError.current(errMessage(err));
    }
  }, []);
  useEffect(() => {
    if (opts.enabled) void loadWorkspaces();
  }, [opts.enabled, loadWorkspaces]);

  useEffect(() => {
    setCampaigns([]);
    setPicked([]);
    setCounts({});
    if (!ws) return;
    let cancelled = false;
    setCampaignsLoading(true);
    fetchCampaigns({ workspace_id: ws, campaign_type: "parent" })
      .then((r) => !cancelled && setCampaigns(r.campaigns ?? []))
      .catch((err) => !cancelled && onError.current(errMessage(err)))
      .finally(() => !cancelled && setCampaignsLoading(false));
    return () => {
      cancelled = true;
    };
  }, [ws]);

  useEffect(() => {
    onChange.current?.();
  }, [ws, picked]);

  const readCount = useCallback(
    (id: string) => {
      setCounts((c) => ({ ...c, [id]: "loading" }));
      const workspaceId = ws;
      countQueue.current = countQueue.current.then(() =>
        fetchLeadsPreview({ workspace_id: workspaceId, campaign_id: id })
          .then((r) => setCounts((c) => ({ ...c, [id]: r.available })))
          .catch(() => setCounts((c) => ({ ...c, [id]: "error" })))
      );
    },
    [ws]
  );

  function toggle(id: string) {
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
    if (counts[id] === undefined) readCount(id);
  }

  /** Reads the ticked campaigns' counts again, after leads were deleted. */
  function refreshCounts() {
    for (const id of picked) readCount(id);
  }

  const expected = useMemo(() => picked.reduce((n, id) => n + (typeof counts[id] === "number" ? (counts[id] as number) : 0), 0), [picked, counts]);
  const countsKnown = picked.length > 0 && picked.every((id) => typeof counts[id] === "number");

  return { workspaces, ws, setWs, campaigns, campaignsLoading, picked, setPicked, filter, setFilter, counts, toggle, refreshCounts, loadWorkspaces, expected, countsKnown };
}

export type CampaignPickState = ReturnType<typeof useCampaignPick>;

export function CampaignPick({ pick, disabled, idPrefix }: { pick: CampaignPickState; disabled: boolean; idPrefix: string }) {
  const { workspaces, ws, setWs, campaigns, campaignsLoading, picked, setPicked, filter, setFilter, counts, toggle } = pick;
  const q = filter.trim().toLowerCase();
  const shown = campaigns.filter((c) => !q || c.name.toLowerCase().includes(q));
  const allShownPicked = shown.length > 0 && shown.every((c) => picked.includes(c.id));

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground" htmlFor={`${idPrefix}-ws`}>
            Workspace
          </label>
          <div className="relative">
            <select id={`${idPrefix}-ws`} className="pv-input appearance-none pr-9" value={ws} disabled={disabled} onChange={(e) => setWs(e.target.value)} aria-label="Workspace">
              <option value="">Pick a workspace</option>
              {workspaces.map((w) => (
                <option key={w._id} value={w._id}>
                  {w.name}
                </option>
              ))}
            </select>
            <ChevronDownIcon size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          </div>
        </div>
      </div>

      {ws && (
        <div data-campaigns>
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              Campaigns{picked.length > 0 ? ` · ${picked.length} picked` : ""}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              {campaigns.length > 8 && (
                <input className="pv-input w-48 py-1 text-xs" placeholder="Filter campaigns…" value={filter} aria-label="Filter campaigns" onChange={(e) => setFilter(e.target.value)} />
              )}
              <button
                type="button"
                className="pv-btn-ghost py-1 text-xs disabled:opacity-50"
                disabled={disabled || shown.length === 0}
                onClick={() => {
                  if (allShownPicked) setPicked((p) => p.filter((id) => !shown.some((c) => c.id === id)));
                  else for (const c of shown) if (!picked.includes(c.id)) toggle(c.id);
                }}
                data-pick-all
              >
                {allShownPicked ? "Clear" : q ? "Pick shown" : "Pick all"}
              </button>
            </div>
          </div>
          {campaignsLoading ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner size={12} /> Loading campaigns…
            </p>
          ) : (
            <div className="pv-scroll max-h-80 overflow-y-auto rounded-xl border border-border p-1.5">
              {shown.map((c) => {
                const n = counts[c.id];
                return (
                  <label key={c.id} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-muted/40" data-campaign-option={c.id}>
                    <input type="checkbox" checked={picked.includes(c.id)} disabled={disabled} onChange={() => toggle(c.id)} aria-label={`Pick ${c.name}`} />
                    <span className="min-w-0 flex-1 truncate">{c.name}</span>
                    {picked.includes(c.id) && (
                      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground" data-count={c.id}>
                        {n === "loading" ? <Spinner size={10} /> : n === "error" ? "count unknown" : typeof n === "number" ? `${formatNumber(n)} not contacted` : ""}
                      </span>
                    )}
                  </label>
                );
              })}
              {shown.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">{campaigns.length === 0 ? "No campaigns in this workspace." : "No campaign matches."}</p>}
            </div>
          )}
        </div>
      )}
    </>
  );
}
