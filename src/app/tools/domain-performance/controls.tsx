"use client";

import type { Workspace } from "@/lib/plusvibe-types";
import { DATE_PRESETS } from "@/lib/format";
import { ChevronDownIcon, RefreshIcon } from "@/components/icons";
import { Spinner } from "@/components/ui";

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

  recpProvider: string | null;
  onRecpProviderChange: (v: string | null) => void;

  onRefresh: () => void;
  busy: boolean;
}

const RECP_OPTIONS: { key: string | null; label: string }[] = [
  { key: null, label: "All inboxes" },
  { key: "GOOGLE_WORKSPACE", label: "Google" },
  { key: "MICROSOFT365", label: "Microsoft" },
  { key: "REGULAR_ACCOUNT", label: "Other" },
];

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

      {/* Presets + recipient filter */}
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
          <span className="text-xs text-muted-foreground">Recipient:</span>
          <div className="flex flex-wrap gap-2">
            {RECP_OPTIONS.map((o) => (
              <button
                key={o.label}
                type="button"
                onClick={() => props.onRecpProviderChange(o.key)}
                className={`pv-chip ${
                  props.recpProvider === o.key ? "pv-chip-active" : "hover:text-foreground"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
