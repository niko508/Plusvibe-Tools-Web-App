"use client";

import type { Workspace } from "@/lib/plusvibe-types";
import { DATE_PRESETS, formatNumber } from "@/lib/format";
import { ChevronDownIcon, RefreshIcon, MailIcon } from "@/components/icons";
import { Spinner } from "@/components/ui";
import { ESP_OPTIONS } from "../domain-performance/providers";
import { ALL_WORKSPACES } from "./types";

// Everything is chosen first; nothing is fetched until a button is pressed.
// Two steps, because they cost differently: finding inboxes is one listing
// call per workspace, and it is what fills in the provider counts so the
// filter can be set BEFORE the stats — which are the expensive part — are
// fetched for just those inboxes.

interface Props {
  workspaces: Workspace[];
  workspacesLoading: boolean;
  /** A workspace id, or ALL_WORKSPACES. */
  scope: string;
  onScopeChange: (v: string) => void;

  start: string;
  end: string;
  activePreset: string | null;
  onPreset: (key: string) => void;
  onStartChange: (v: string) => void;
  onEndChange: (v: string) => void;
  /** Why the range can't be fetched, or null. */
  rangeProblem: string | null;

  senderProvider: string | null;
  onSenderProviderChange: (v: string | null) => void;
  /** Inboxes per ESP among what was found. */
  senderCounts: Record<string, number>;

  includeChart: boolean;
  onIncludeChartChange: (v: boolean) => void;

  onFind: () => void;
  onLoad: () => void;
  findBusy: boolean;
  statsBusy: boolean;
  /** Inboxes found so far, before any filtering. */
  inboxesKnown: number;
  /** Inboxes in scope that still need their stats. */
  toLoad: number;
}

export function Controls(props: Props) {
  const anyBusy = props.findBusy || props.statsBusy;
  return (
    <div className="pv-card p-4 sm:p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:flex-wrap lg:items-end">
        {/* Scope */}
        <div className="min-w-[240px] flex-1">
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
            Workspace
          </label>
          <div className="relative">
            <select
              className="pv-input appearance-none pr-9"
              value={props.scope}
              disabled={props.workspacesLoading || props.workspaces.length === 0 || anyBusy}
              onChange={(e) => props.onScopeChange(e.target.value)}
              aria-label="Workspace scope"
            >
              {props.workspacesLoading && <option>Loading workspaces…</option>}
              {!props.workspacesLoading && props.workspaces.length === 0 && (
                <option>No workspaces found</option>
              )}
              {!props.workspacesLoading && props.workspaces.length > 0 && (
                <>
                  <option value={ALL_WORKSPACES}>
                    All workspaces ({props.workspaces.length})
                  </option>
                  {props.workspaces.map((w) => (
                    <option key={w._id} value={w._id}>
                      {w.name}
                    </option>
                  ))}
                </>
              )}
            </select>
            <ChevronDownIcon
              size={16}
              className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">From</label>
          <input
            type="date"
            className="pv-input"
            value={props.start}
            max={props.end}
            onChange={(e) => props.onStartChange(e.target.value)}
            aria-label="From date"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">To</label>
          <input
            type="date"
            className="pv-input"
            value={props.end}
            min={props.start}
            onChange={(e) => props.onEndChange(e.target.value)}
            aria-label="To date"
          />
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={`${props.inboxesKnown === 0 ? "pv-btn-primary" : "pv-btn-ghost"} disabled:opacity-50`}
            onClick={props.onFind}
            disabled={anyBusy || props.workspaces.length === 0}
            title="Lists the inboxes in scope: one call per workspace. No stats yet."
          >
            {props.findBusy ? <Spinner /> : <MailIcon size={16} />}
            {props.findBusy
              ? "Finding inboxes…"
              : props.inboxesKnown > 0
                ? "Find again"
                : "Find inboxes"}
          </button>
          <button
            type="button"
            className={`${props.inboxesKnown > 0 ? "pv-btn-primary" : "pv-btn-ghost"} disabled:opacity-50`}
            onClick={props.onLoad}
            disabled={anyBusy || props.toLoad === 0 || !!props.rangeProblem}
            title="Fetches the date range's figures for the inboxes in scope, 100 per call."
          >
            {props.statsBusy ? <Spinner /> : <RefreshIcon size={16} />}
            {props.statsBusy
              ? "Loading stats…"
              : props.toLoad > 0
                ? `Load stats for ${formatNumber(props.toLoad)} inbox${props.toLoad === 1 ? "" : "es"}`
                : props.inboxesKnown > 0
                  ? "All loaded"
                  : "Load stats"}
          </button>
        </div>
      </div>

      {props.rangeProblem && (
        <p className="mt-2 text-xs text-danger">{props.rangeProblem}</p>
      )}

      <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2">
          {DATE_PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => props.onPreset(p.key)}
              className={`pv-chip ${
                props.activePreset === p.key ? "pv-chip-active" : "hover:text-foreground"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Sending inboxes:</span>
            <div className="flex flex-wrap gap-2">
              {ESP_OPTIONS.map((o) => {
                const count = o.key === null ? null : (props.senderCounts[o.key] ?? 0);
                return (
                  <button
                    key={o.label}
                    type="button"
                    onClick={() => props.onSenderProviderChange(o.key)}
                    className={`pv-chip ${
                      props.senderProvider === o.key ? "pv-chip-active" : "hover:text-foreground"
                    } ${count === 0 && props.inboxesKnown > 0 ? "opacity-40" : ""}`}
                  >
                    {o.key === null ? "All" : o.label}
                    {count !== null && props.inboxesKnown > 0 && (
                      <span className="ml-1.5 tabular-nums opacity-60">{formatNumber(count)}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
          <label
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
            title="Per-day figures for the chart. Leaving it off makes the stats download much smaller across many inboxes."
          >
            <input
              type="checkbox"
              checked={props.includeChart}
              onChange={(e) => props.onIncludeChartChange(e.target.checked)}
              aria-label="Fetch daily chart data"
            />
            Daily chart
          </label>
        </div>
      </div>
    </div>
  );
}
