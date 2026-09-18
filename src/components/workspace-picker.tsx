"use client";

import { useMemo, useState } from "react";
import type { Workspace } from "@/lib/plusvibe-types";
import { formatNumber } from "@/lib/format";
import { Spinner } from "@/components/ui";
import { AlertIcon, RefreshIcon } from "@/components/icons";

// Pick some (or all) workspaces. Shared by General Bulk Actions and by any tool
// that can run across workspaces, so "select all" behaves the same everywhere:
// it applies to what's on screen, so a filtered search picks a subset without
// silently including everything behind the filter.

export function WorkspacePicker({
  workspaces,
  selected,
  onChange,
  loading,
  error,
  onReload,
}: {
  workspaces: Workspace[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  loading: boolean;
  error?: string | null;
  onReload?: () => void;
}) {
  const [filter, setFilter] = useState("");

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return workspaces;
    return workspaces.filter((w) => w.name.toLowerCase().includes(q));
  }, [workspaces, filter]);

  const allVisibleSelected =
    visible.length > 0 && visible.every((w) => selected.has(w._id));

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  }

  function toggleAllVisible() {
    const next = new Set(selected);
    for (const w of visible) {
      if (allVisibleSelected) next.delete(w._id);
      else next.add(w._id);
    }
    onChange(next);
  }

  return (
    <div className="pv-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">
          Workspaces{" "}
          <span className="font-normal text-muted-foreground">
            · {formatNumber(selected.size)} of {formatNumber(workspaces.length)} selected
          </span>
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            className="pv-input h-8 w-44 text-xs"
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button
            type="button"
            className="pv-btn-ghost text-xs"
            disabled={visible.length === 0}
            onClick={toggleAllVisible}
          >
            {allVisibleSelected
              ? `Clear ${filter ? "shown" : "all"}`
              : `Select ${filter ? "shown" : "all"}`}
          </button>
          {onReload && (
            <button type="button" className="pv-btn-ghost text-xs" onClick={onReload} disabled={loading}>
              {loading ? <Spinner size={14} /> : <RefreshIcon size={14} />}
              Reload
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="mt-3 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger">
          <AlertIcon size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading && workspaces.length === 0 ? (
        <div className="mt-4 h-24 animate-pulse rounded-xl bg-muted" />
      ) : visible.length === 0 ? (
        <p className="mt-4 text-xs text-muted-foreground">
          {workspaces.length === 0 ? "No workspaces found." : "No workspaces match that filter."}
        </p>
      ) : (
        <div className="pv-scroll mt-4 max-h-64 overflow-y-auto rounded-xl border border-border">
          <div className="grid gap-px sm:grid-cols-2 lg:grid-cols-3">
            {visible.map((w) => (
              <label
                key={w._id}
                className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs transition hover:bg-muted/50"
              >
                <input type="checkbox" checked={selected.has(w._id)} onChange={() => toggle(w._id)} />
                <span className="truncate" title={w.name}>
                  {w.name}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
