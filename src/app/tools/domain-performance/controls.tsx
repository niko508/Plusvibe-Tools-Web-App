"use client";

import type { Workspace } from "@/lib/plusvibe-types";
import { DATE_PRESETS } from "@/lib/format";
import { ChevronDownIcon, RefreshIcon } from "@/components/icons";
import { Spinner } from "@/components/ui";
import { ALL_ESP, ESP_OPTIONS } from "./providers";

interface Props {
  workspaces: Workspace[];
  workspacesLoading: boolean;
  workspaceId: string | null;
  onWorkspaceChange: (id: string) => void;

  start: string;
  end: string;
  activePreset: string | null;
  onPreset: (key: string) => void;
  onStartChange: (v: string) => void;
  onEndChange: (v: string) => void;

  // Sending-inbox ESP selector. Nothing is selected (null) until the user picks
  // one, and picking one is what triggers the per-domain stats fetch — so the
  // tool never loads every domain in the workspace up front.
  senderProvider: string | null;
  onSenderProviderChange: (v: string) => void;
  senderCounts: Record<string, number>; // domains per ESP, for the chip counts
  domainCount: number; // total sending domains found, for the "All" chip
  espDisabled: boolean; // no domain list yet, so there is nothing to pick from

  onRefresh: () => void;
  busy: boolean;
}

interface EspChipsProps {
  value: string | null;
  onChange: (v: string) => void;
  counts: Record<string, number>;
  total: number;
  disabled?: boolean;
  size?: "sm" | "lg";
}

/**
 * The sending-inbox type picker. Rendered both in the controls bar and, while
 * no type is selected, as the primary call to action below it — same component
 * either way so the two can't drift apart.
 */
export function EspChips({
  value,
  onChange,
  counts,
  total,
  disabled = false,
  size = "sm",
}: EspChipsProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {ESP_OPTIONS.map((o) => {
        const count = o.key === ALL_ESP ? total : counts[o.key] ?? 0;
        const empty = count === 0;
        return (
          <button
            key={o.key}
            type="button"
            disabled={disabled || empty}
            onClick={() => onChange(o.key)}
            className={`pv-chip ${size === "lg" ? "px-4 py-2 text-sm" : ""} ${
              value === o.key ? "pv-chip-active" : "hover:text-foreground"
            } ${disabled || empty ? "cursor-not-allowed opacity-40" : ""}`}
            title={
              empty && !disabled
                ? "No domains sending through this provider"
                : undefined
            }
          >
            {o.label}
            <span className="ml-1.5 tabular-nums opacity-60">{count}</span>
          </button>
        );
      })}
    </div>
  );
}

export function Controls(props: Props) {
  return (
    <div className="pv-card p-4 sm:p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:flex-wrap lg:items-end">
        {/* Workspace */}
        <div className="min-w-[220px] flex-1">
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
            Workspace
          </label>
          <div className="relative">
            <select
              className="pv-input appearance-none pr-9"
              value={props.workspaceId ?? ""}
              disabled={props.workspacesLoading || props.workspaces.length === 0}
              onChange={(e) => props.onWorkspaceChange(e.target.value)}
            >
              {props.workspacesLoading && <option>Loading workspaces…</option>}
              {!props.workspacesLoading && props.workspaces.length === 0 && (
                <option>No workspaces found</option>
              )}
              {!props.workspacesLoading &&
                props.workspaces.map((w) => (
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

        {/* Custom dates */}
        <div>
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
            From
          </label>
          <input
            type="date"
            className="pv-input"
            value={props.start}
            max={props.end}
            onChange={(e) => props.onStartChange(e.target.value)}
          />
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
            To
          </label>
          <input
            type="date"
            className="pv-input"
            value={props.end}
            min={props.start}
            onChange={(e) => props.onEndChange(e.target.value)}
          />
        </div>

        <button
          type="button"
          className="pv-btn-primary"
          onClick={props.onRefresh}
          disabled={props.busy || !props.workspaceId}
        >
          {props.busy ? <Spinner /> : <RefreshIcon size={16} />}
          {props.busy ? "Loading…" : "Refresh"}
        </button>
      </div>

      {/* Presets + sending-inbox filter */}
      <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
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

        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Sending inboxes:</span>
          <EspChips
            value={props.senderProvider}
            onChange={props.onSenderProviderChange}
            counts={props.senderCounts}
            total={props.domainCount}
            disabled={props.espDisabled}
          />
        </div>
      </div>
    </div>
  );
}
