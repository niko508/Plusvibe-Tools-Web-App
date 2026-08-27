"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Workspace } from "@/lib/plusvibe-types";
import { fetchWorkspaces, ApiClientError } from "@/lib/api-client";
import { useApiKey } from "@/lib/use-api-key";
import { formatNumber } from "@/lib/format";
import { ConnectPrompt } from "@/components/connect-prompt";
import { Spinner } from "@/components/ui";
import { AlertIcon, RefreshIcon } from "@/components/icons";
import { AddWebhook } from "./add-webhook";

// The container for actions that run across many workspaces at once. The
// workspace picker is shared, so a second action only has to add its own panel.
const ACTIONS = [{ id: "add-webhook", label: "Add webhook" }] as const;
type ActionId = (typeof ACTIONS)[number]["id"];

export function BulkActionsTool() {
  const { hasKey, ready } = useApiKey();
  const [action, setAction] = useState<ActionId>("add-webhook");

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { workspaces: list } = await fetchWorkspaces();
      setWorkspaces(list);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Something went wrong"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (ready && hasKey) void load();
  }, [ready, hasKey, load]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return workspaces;
    return workspaces.filter((w) => w.name.toLowerCase().includes(q));
  }, [workspaces, filter]);

  // Select-all applies to what's on screen, so a filtered search can be used to
  // pick a subset without silently including everything behind the filter.
  const allVisibleSelected =
    visible.length > 0 && visible.every((w) => selected.has(w._id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const w of visible) {
        if (allVisibleSelected) next.delete(w._id);
        else next.add(w._id);
      }
      return next;
    });
  }

  if (!ready) return <div className="pv-card h-40 animate-pulse" />;
  if (!hasKey) return <ConnectPrompt onConnected={load} />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        {ACTIONS.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => setAction(a.id)}
            className={`pv-chip ${
              action === a.id ? "pv-chip-active" : "hover:text-foreground"
            }`}
          >
            {a.label}
          </button>
        ))}
      </div>

      {/* Workspace picker — shared by every action */}
      <div className="pv-card p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">
              Workspaces{" "}
              <span className="font-normal text-muted-foreground">
                · {formatNumber(selected.size)} of{" "}
                {formatNumber(workspaces.length)} selected
              </span>
            </h2>
          </div>
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
            <button
              type="button"
              className="pv-btn-ghost text-xs"
              onClick={load}
              disabled={loading}
            >
              {loading ? <Spinner size={14} /> : <RefreshIcon size={14} />}
              Reload
            </button>
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
            {workspaces.length === 0
              ? "No workspaces found."
              : "No workspaces match that filter."}
          </p>
        ) : (
          <div className="pv-scroll mt-4 max-h-64 overflow-y-auto rounded-xl border border-border">
            <div className="grid gap-px sm:grid-cols-2 lg:grid-cols-3">
              {visible.map((w) => (
                <label
                  key={w._id}
                  className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs transition hover:bg-muted/50"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(w._id)}
                    onChange={() => toggle(w._id)}
                  />
                  <span className="truncate" title={w.name}>
                    {w.name}
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}
      </div>

      {action === "add-webhook" && (
        <AddWebhook
          workspaces={workspaces}
          selected={selected}
          loading={loading}
        />
      )}
    </div>
  );
}
