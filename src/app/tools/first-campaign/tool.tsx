"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Workspace } from "@/lib/plusvibe-types";
import type { FirstCampaignJob } from "@/lib/jobs/first-campaign-types";
import {
  fetchWorkspaces,
  startFirstCampaign,
  listFirstCampaignJobs,
  abortFirstCampaign,
  deleteFirstCampaignJob,
  ApiClientError,
} from "@/lib/api-client";
import { useApiKey } from "@/lib/use-api-key";
import { ConnectPrompt } from "@/components/connect-prompt";
import { EmptyState, Spinner } from "@/components/ui";
import { AlertIcon, ChevronDownIcon, SparklesIcon } from "@/components/icons";
import { JobCard } from "./job-card";
import { Blueprint } from "./blueprint-summary";

const LAST_WS_KEY = "pv_last_workspace";
/** While something is running the list is polled; idle it just sits there. */
const POLL_MS = 2000;

export function FirstCampaignTool() {
  const { hasKey, ready } = useApiKey();

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(false);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [campaignName, setCampaignName] = useState("");

  const [jobs, setJobs] = useState<FirstCampaignJob[]>([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadWorkspaces = useCallback(async () => {
    setWorkspacesLoading(true);
    setError(null);
    try {
      const res = await fetchWorkspaces();
      const list = res.workspaces ?? [];
      setWorkspaces(list);
      if (list.length) {
        const stored =
          typeof window !== "undefined"
            ? window.localStorage.getItem(LAST_WS_KEY)
            : null;
        setWorkspaceId(list.find((w) => w._id === stored)?._id ?? list[0]._id);
      } else {
        setWorkspaceId(null);
      }
    } catch (err) {
      setError(errMessage(err));
      setWorkspaces([]);
    } finally {
      setWorkspacesLoading(false);
    }
  }, []);

  const refreshJobs = useCallback(async () => {
    try {
      const res = await listFirstCampaignJobs();
      setJobs(res.jobs ?? []);
      return res.jobs ?? [];
    } catch {
      // A failed poll is not worth an error banner — the next one may work,
      // and the job itself keeps running on the server regardless.
      return [];
    }
  }, []);

  useEffect(() => {
    if (ready && hasKey) {
      void loadWorkspaces();
      void refreshJobs();
    } else if (ready && !hasKey) {
      setWorkspaces([]);
      setWorkspaceId(null);
      setJobs([]);
    }
  }, [ready, hasKey, loadWorkspaces, refreshJobs]);

  // Poll only while something is actually running.
  useEffect(() => {
    if (pollRef.current) clearTimeout(pollRef.current);
    if (!jobs.some((j) => j.status === "running")) return;
    pollRef.current = setTimeout(() => {
      void refreshJobs();
    }, POLL_MS);
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [jobs, refreshJobs]);

  const running = jobs.find((j) => j.status === "running");
  const trimmedName = campaignName.trim();
  const canStart =
    !!workspaceId && trimmedName.length > 0 && !starting && !running;

  async function handleStart() {
    if (!workspaceId || !trimmedName) return;
    setStarting(true);
    setError(null);
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(LAST_WS_KEY, workspaceId);
      }
      await startFirstCampaign({
        workspaceId,
        workspaceName:
          workspaces.find((w) => w._id === workspaceId)?.name ?? "",
        campaignName: trimmedName,
      });
      setCampaignName("");
      await refreshJobs();
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setStarting(false);
    }
  }

  async function handleAbort(id: string) {
    try {
      await abortFirstCampaign(id);
    } catch (err) {
      setError(errMessage(err));
    }
    await refreshJobs();
  }

  async function handleRemove(id: string) {
    // Dropped locally first so the card disappears immediately; the refresh
    // below is what confirms it.
    setJobs((prev) => prev.filter((j) => j.id !== id));
    try {
      await deleteFirstCampaignJob(id);
    } catch (err) {
      setError(errMessage(err));
    }
    await refreshJobs();
  }

  if (!ready) return <div className="pv-card h-40 animate-pulse" />;
  if (!hasKey) return <ConnectPrompt onConnected={loadWorkspaces} />;

  return (
    <div className="space-y-5">
      <div className="pv-card p-4 sm:p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end">
          <div className="min-w-[220px] flex-1">
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Workspace
            </label>
            <div className="relative">
              <select
                className="pv-input appearance-none pr-9"
                value={workspaceId ?? ""}
                disabled={workspacesLoading || workspaces.length === 0}
                onChange={(e) => setWorkspaceId(e.target.value)}
              >
                {workspacesLoading && <option>Loading workspaces…</option>}
                {!workspacesLoading && workspaces.length === 0 && (
                  <option>No workspaces found</option>
                )}
                {!workspacesLoading &&
                  workspaces.map((w) => (
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

          <div className="min-w-[240px] flex-1">
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Campaign name
            </label>
            <input
              type="text"
              className="pv-input"
              placeholder="e.g. Tree Removal (August)"
              value={campaignName}
              maxLength={200}
              onChange={(e) => setCampaignName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canStart) void handleStart();
              }}
            />
          </div>

          <button
            type="button"
            className="pv-btn-primary disabled:opacity-50"
            disabled={!canStart}
            onClick={handleStart}
          >
            {starting ? <Spinner /> : <SparklesIcon size={16} />}
            {starting ? "Starting…" : "Create campaign"}
          </button>
        </div>

        {running && (
          <p className="mt-3 text-xs text-muted-foreground">
            A campaign is being built. Only one runs at a time — creating labels
            and campaigns twice over would leave duplicates behind.
          </p>
        )}

        <Blueprint />
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          <AlertIcon size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {jobs.length > 0 ? (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold">Tasks</h2>
          {jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              onAbort={handleAbort}
              onRemove={handleRemove}
            />
          ))}
        </div>
      ) : (
        <EmptyState icon={<SparklesIcon />} title="No campaigns built yet">
          Pick the new client&apos;s workspace, name the campaign, and it builds
          the whole thing — you can close the tab, it keeps running.
        </EmptyState>
      )}
    </div>
  );
}

function errMessage(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
