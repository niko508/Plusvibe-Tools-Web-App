"use client";

import { useCallback, useEffect, useState } from "react";
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
  PauseIcon,
} from "@/components/icons";
import { TOOL_COLORS, type ToolColor } from "@/lib/tools";
import { AddWebhook } from "./add-webhook";
import { AddLabel } from "./add-label";
import { AddField } from "./add-field";
import { PauseCampaigns } from "./pause-campaigns";
import { AddTags } from "./add-tags";
import { InboxTags } from "./inbox-tags";
import { CampaignSettings } from "./campaign-settings";
import { WorkspacePicker } from "@/components/workspace-picker";

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
    id: "add-tags",
    name: "Add Tags",
    description:
      "Create one or more tags — name, colour, optional description — in every selected workspace, skipping any it already has.",
    color: "emerald",
    Icon: TagIcon,
    ready: true,
  },
  {
    id: "inbox-tags",
    name: "Update Inbox Tags",
    description:
      "Add a tag to every inbox, or just the Google or Microsoft ones, across the selected workspaces. Existing tags are kept. Runs in the background.",
    color: "sky",
    Icon: MailIcon,
    ready: true,
  },
  {
    id: "campaign-settings",
    name: "Change Campaign Settings",
    description:
      "Set ESP matching, stop-on-reply, tracking and other settings on every active campaign in the selected workspaces. Runs in the background.",
    color: "violet",
    Icon: LayersIcon,
    ready: true,
  },
  {
    id: "pause-campaigns",
    name: "Pause & Continue Campaigns",
    description:
      "Pause every active campaign — sub-sequences included — in the selected workspaces, then continue exactly those campaigns at a date you pick, or by hand.",
    color: "orange",
    Icon: PauseIcon,
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
      <WorkspacePicker
        workspaces={workspaces}
        selected={selected}
        onChange={setSelected}
        loading={loading}
        error={error}
        onReload={load}
      />

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

          {action === "add-tags" && (
            <AddTags workspaces={workspaces} selected={selected} loading={loading} />
          )}

          {action === "inbox-tags" && (
            <InboxTags workspaces={workspaces} selected={selected} loading={loading} />
          )}

          {action === "campaign-settings" && (
            <CampaignSettings workspaces={workspaces} selected={selected} loading={loading} />
          )}

          {action === "pause-campaigns" && (
            <PauseCampaigns
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
