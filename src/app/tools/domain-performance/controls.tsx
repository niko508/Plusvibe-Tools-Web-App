"use client";

import type { Workspace } from "@/lib/plusvibe-types";
import { DATE_PRESETS } from "@/lib/format";
import { ChevronDownIcon, RefreshIcon } from "@/components/icons";
import { Spinner } from "@/components/ui";
import { ESP_OPTIONS } from "./providers";

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

  // Sending-inbox ESP filter. Applied client-side to the already-loaded
  // domains, so switching it is instant — no refetch.
  senderProvider: string | null;
  onSenderProviderChange: (v: string | null) => void;
  senderCounts: Record<string, number>; // domains per ESP, for the chip counts

  onRefresh: () => void;
  /** Stats are being fetched. */
  busy: boolean;
  /** The workspace's domain list is still being discovered. */
  domainsBusy: boolean;
  /** Domains in scope that still need their stats fetched. */
  toLoad: number;
  /** Domains discovered in the workspace, before any filtering. */
  domainsKnown: number;
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

        {/* Stats are a request per domain, so they're loaded on demand rather
            than the moment a workspace is picked — pick the provider first and
            only those domains are fetched. */}
        <button
          type="button"
          className="pv-btn-primary disabled:opacity-50"
          onClick={props.onRefresh}
          disabled={
            props.busy ||
            props.domainsBusy ||
            !props.workspaceId ||
            props.toLoad === 0
          }
        >
          {props.busy || props.domainsBusy ? (
            <Spinner />
          ) : (
            <RefreshIcon size={16} />
          )}
          {props.domainsBusy
            ? "Finding domains…"
            : props.busy
              ? "Loading stats…"
              : props.toLoad > 0
                ? `Load ${props.toLoad} domain${props.toLoad === 1 ? "" : "s"}`
                : props.domainsKnown > 0
                  ? "All loaded"
                  : "Load"}
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
          <div className="flex flex-wrap gap-2">
            {ESP_OPTIONS.map((o) => {
              const count = o.key === null ? null : props.senderCounts[o.key] ?? 0;
              return (
                <button
                  key={o.label}
                  type="button"
                  onClick={() => props.onSenderProviderChange(o.key)}
                  className={`pv-chip ${
                    props.senderProvider === o.key
                      ? "pv-chip-active"
                      : "hover:text-foreground"
                  } ${count === 0 ? "opacity-40" : ""}`}
                  title={
                    count === 0
                      ? "No domains sending through this provider"
                      : undefined
                  }
                >
                  {o.key === null ? "All" : o.label}
                  {count !== null && (
                    <span className="ml-1.5 tabular-nums opacity-60">{count}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
