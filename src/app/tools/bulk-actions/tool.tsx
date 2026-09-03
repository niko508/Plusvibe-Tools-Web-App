"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Workspace } from "@/lib/plusvibe-types";
import { fetchWorkspaces, ApiClientError } from "@/lib/api-client";
import { useApiKey } from "@/lib/use-api-key";
import { formatNumber } from "@/lib/format";
import { ConnectPrompt } from "@/components/connect-prompt";
import { Spinner } from "@/components/ui";
import {
  AlertIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ClockIcon,
  RefreshIcon,
  ZapIcon,
  MailIcon,
  TagIcon,
  TrashIcon,
  LayersIcon,
} from "@/components/icons";
import { TOOL_COLORS, type ToolColor } from "@/lib/tools";
import { AddWebhook } from "./add-webhook";
import { AddLabel } from "./add-label";
import { AddField } from "./add-field";

// The container for actions that run across many workspaces at once.
//
// The landing view is a card grid mirroring the home page, so adding an action
// is one entry here plus its panel. The workspace picker is shared, so an
// action never has to build its own.
interface BulkAction {
  id: string;
  name: string;
  description: string;
  color: ToolColor;
  Icon: typeof ZapIcon;
  ready: boolean;
}

const ACTIONS: BulkAction[] = [
  {
    id: "add-webhook",
    name: "Add Webhook",
    description:
      "Create the same webhook in every selected workspace, skipping any that already point at the same URL.",
    color: "indigo",
    Icon: ZapIcon,
    ready: true,
  },
  {
    id: "add-label",
    name: "Add Custom Label",
    description:
      "Create the same custom lead label — emoji and all — in every selected workspace, skipping any that already have it.",
    color: "amber",
    Icon: TagIcon,
    ready: true,
  },
  {
    id: "add-field",
    name: "Add Additional Field",
    description:
      "Create the same custom lead field — with an optional default — in every selected workspace, skipping any that already have it.",
    color: "cyan",
    Icon: LayersIcon,
    ready: true,
  },
  {
    id: "remove-webhook",
    name: "Remove Webhook",
    description:
      "Delete a webhook by URL from every selected workspace at once.",
    color: "rose",
    Icon: TrashIcon,
    ready: false,
  },
  {
    id: "invite-user",
    name: "Invite User",
    description:
      "Add the same teammate to a batch of workspaces without opening each one.",
    color: "teal",
    Icon: MailIcon,
    ready: false,
  },
];
type ActionId = string;

export function BulkActionsTool() {
  const { hasKey, ready } = useApiKey();
  // null = the menu. Actions open into their own view with a way back.
  const [action, setAction] = useState<ActionId | null>(null);

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
      {action === null ? (
        <ActionMenu onPick={setAction} />
      ) : (
        <>
          <button
            type="button"
            className="pv-btn-ghost text-xs"
            onClick={() => setAction(null)}
          >
            <ArrowLeftIcon size={14} />
            All bulk actions
          </button>

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

          {action === "add-label" && (
            <AddLabel
              workspaces={workspaces}
              selected={selected}
              loading={loading}
            />
          )}

          {action === "add-field" && (
            <AddField
              workspaces={workspaces}
              selected={selected}
              loading={loading}
            />
          )}
        </>
      )}
    </div>
  );
}

/** The card grid, mirroring the home page's tool picker one level down. */
function ActionMenu({ onPick }: { onPick: (id: ActionId) => void }) {
  return (
    <div>
      <h2 className="mb-4 text-sm font-medium uppercase tracking-wide text-muted-foreground">
        Actions
      </h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {ACTIONS.map((a) => {
          const c = TOOL_COLORS[a.color];
          const Icon = a.Icon;
          return (
            <button
              key={a.id}
              type="button"
              disabled={!a.ready}
              onClick={() => a.ready && onPick(a.id)}
              className={`pv-card group relative flex h-full flex-col p-5 text-left transition ${
                a.ready
                  ? `hover:-translate-y-0.5 hover:shadow-card ${c.border}`
                  : "cursor-default opacity-70"
              }`}
            >
              <div className="mb-4 flex items-center justify-between">
                <span
                  className={`flex h-11 w-11 items-center justify-center rounded-xl ${
                    a.ready ? c.tile : "bg-muted text-muted-foreground"
                  }`}
                >
                  <Icon size={22} />
                </span>
                {!a.ready && (
                  <span className="pv-chip">
                    <ClockIcon size={12} />
                    Coming soon
                  </span>
                )}
              </div>
              <h3 className="text-base font-semibold">{a.name}</h3>
              <p className="mt-1.5 flex-1 text-sm leading-relaxed text-muted-foreground">
                {a.description}
              </p>
              {a.ready && (
                <span
                  className={`mt-5 inline-flex items-center gap-1.5 text-sm font-medium ${c.link}`}
                >
                  Open
                  <ArrowRightIcon size={16} />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
