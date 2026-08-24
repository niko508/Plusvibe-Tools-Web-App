"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Workspace, CampaignSummary } from "@/lib/plusvibe-types";
import type {
  CampaignRole,
  CampaignTypesJob,
  RoleCampaign,
} from "@/lib/jobs/campaign-types-types";
import {
  fetchWorkspaces,
  fetchCampaigns,
  startCampaignTypes,
  listCampaignTypesJobs,
  abortCampaignTypes,
  deleteCampaignTypesJob,
  ApiClientError,
} from "@/lib/api-client";
import { useApiKey } from "@/lib/use-api-key";
import { ConnectPrompt } from "@/components/connect-prompt";
import { Spinner, EmptyState } from "@/components/ui";
import {
  LayersIcon,
  AlertIcon,
  RefreshIcon,
  ChevronDownIcon,
  CheckIcon,
} from "@/components/icons";
import { deriveNames } from "@/lib/campaign-types/names";
import { matchCompanions, type MatchRole } from "@/lib/campaign-types/match";
import { JobCard } from "./job-card";

const POLL_MS = 2000;
const ROLE_LABELS: Record<MatchRole, string> = {
  blue: "Microsoft copy",
  optOut: "Opt Out copy",
  blueOptOut: "Microsoft + Opt Out copy",
};

export function CampaignTypesTool() {
  const { hasKey, ready } = useApiKey();

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [workspacesLoading, setWorkspacesLoading] = useState(false);

  const [campaigns, setCampaigns] = useState<CampaignSummary[] | null>(null);
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [sourceId, setSourceId] = useState<string>("");

  // Manual overrides for roles the name match couldn't resolve.
  const [overrides, setOverrides] = useState<Partial<Record<MatchRole, string>>>({});
  const [skipOptOut, setSkipOptOut] = useState(false);

  const [jobs, setJobs] = useState<CampaignTypesJob[]>([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const startLock = useRef(false);

  // --- Loading -------------------------------------------------------------
  const loadWorkspaces = useCallback(async () => {
    setWorkspacesLoading(true);
    setError(null);
    try {
      const { workspaces: list } = await fetchWorkspaces();
      setWorkspaces(list);
      if (list.length > 0) setWorkspaceId((prev) => prev ?? list[0]._id);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setWorkspacesLoading(false);
    }
  }, []);

  const refreshJobs = useCallback(async () => {
    try {
      const { jobs: list } = await listCampaignTypesJobs();
      setJobs(list);
    } catch {
      // polling failure is not worth a banner
    }
  }, []);

  useEffect(() => {
    if (ready && hasKey) {
      void loadWorkspaces();
      void refreshJobs();
    }
  }, [ready, hasKey, loadWorkspaces, refreshJobs]);

  // Poll while anything is running so progress moves without a manual refresh.
  const anyRunning = jobs.some((j) => j.status === "running");
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => void refreshJobs(), POLL_MS);
    return () => clearInterval(t);
  }, [anyRunning, refreshJobs]);

  const loadCampaigns = useCallback(
    async (wsId: string) => {
      setCampaignsLoading(true);
      setCampaigns(null);
      setSourceId("");
      setOverrides({});
      setError(null);
      try {
        const { campaigns: list } = await fetchCampaigns({ workspace_id: wsId });
        setCampaigns(list);
      } catch (err) {
        setError(errMessage(err));
      } finally {
        setCampaignsLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    if (workspaceId) void loadCampaigns(workspaceId);
  }, [workspaceId, loadCampaigns]);

  // --- Derived -------------------------------------------------------------
  // Sub-sequences are separate campaign records and are never pickable here.
  const parents = useMemo(
    () => (campaigns ?? []).filter((c) => c.campaignType !== "subseq"),
    [campaigns]
  );

  const source = parents.find((c) => c.id === sourceId) ?? null;
  const names = source ? deriveNames(source.name) : null;

  const match = useMemo(() => {
    if (!source) return null;
    return matchCompanions(source.name, parents, source.id);
  }, [source, parents]);

  /** Role → campaign, taking any manual override first. */
  const resolved = useMemo(() => {
    const out: Partial<Record<MatchRole, CampaignSummary>> = {};
    if (!match) return out;
    for (const m of match.matches) {
      const overrideId = overrides[m.role];
      if (overrideId) {
        const c = parents.find((p) => p.id === overrideId);
        if (c) out[m.role] = c;
        continue;
      }
      if (m.match) out[m.role] = parents.find((p) => p.id === m.match!.id);
    }
    return out;
  }, [match, overrides, parents]);

  const roleIds = [sourceId, ...Object.values(resolved).map((c) => c?.id)].filter(
    Boolean
  ) as string[];
  const hasDuplicateRole = new Set(roleIds).size !== roleIds.length;
  const allRolesFilled =
    !!source && (["blue", "optOut", "blueOptOut"] as MatchRole[]).every((r) => resolved[r]);

  const activeJob = jobs.find((j) => j.status === "running") ?? null;
  const canStart =
    allRolesFilled && !hasDuplicateRole && !activeJob && !starting;

  // --- Actions -------------------------------------------------------------
  async function handleStart() {
    if (!source || !allRolesFilled || startLock.current) return;
    startLock.current = true;
    setStarting(true);
    setError(null);
    try {
      const roleCampaigns: RoleCampaign[] = [
        { role: "source" as CampaignRole, campaignId: source.id, name: source.name },
        ...(["blue", "optOut", "blueOptOut"] as MatchRole[]).map((r) => ({
          role: r as CampaignRole,
          campaignId: resolved[r]!.id,
          name: resolved[r]!.name,
        })),
      ];
      await startCampaignTypes({
        workspaceId: workspaceId!,
        workspaceName: workspaces.find((w) => w._id === workspaceId)?.name ?? "",
        campaigns: roleCampaigns,
        skipOptOutCopy: skipOptOut,
      });
      setToast("Job started — you can close this tab");
      setTimeout(() => setToast(null), 5000);
      await refreshJobs();
    } catch (err) {
      setError(errMessage(err));
    } finally {
      startLock.current = false;
      setStarting(false);
    }
  }

  // --- Render --------------------------------------------------------------
  if (!ready) return <div className="pv-card h-40 animate-pulse" />;
  if (!hasKey) return <ConnectPrompt onConnected={loadWorkspaces} />;

  return (
    <div className="space-y-5">
      {/* Setup */}
      <div className="pv-card space-y-4 p-4 sm:p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
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

          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Original campaign
            </label>
            <div className="relative">
              <select
                className="pv-input appearance-none pr-9"
                value={sourceId}
                disabled={campaignsLoading || parents.length === 0}
                onChange={(e) => {
                  setSourceId(e.target.value);
                  setOverrides({});
                }}
              >
                <option value="">
                  {campaignsLoading ? "Loading campaigns…" : "Select a campaign…"}
                </option>
                {parents.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <ChevronDownIcon
                size={16}
                className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
            </div>
          </div>
        </div>

        {/* Companion matching */}
        {source && names && match && (
          <div className="rounded-xl border border-border p-3 sm:p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">The other three campaigns</h3>
              <button
                type="button"
                className="pv-btn-ghost text-xs"
                onClick={() => workspaceId && loadCampaigns(workspaceId)}
              >
                <RefreshIcon size={14} />
                Re-check
              </button>
            </div>
            <p className="mb-3 text-xs text-muted-foreground">
              Matched by name against this workspace. Create any that are missing
              in Plusvibe (duplicating the original, sub-sequences included), then
              hit Re-check.
            </p>

            <div className="space-y-2">
              {match.matches.map((m) => {
                const picked = resolved[m.role];
                return (
                  <div
                    key={m.role}
                    className="flex flex-col gap-2 rounded-lg border border-border/70 p-2.5 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        {picked ? (
                          <span className={m.loose && !overrides[m.role] ? "text-warning" : "text-success"}>
                            <CheckIcon size={14} />
                          </span>
                        ) : (
                          <span className="text-warning">
                            <AlertIcon size={14} />
                          </span>
                        )}
                        <span className="truncate font-mono text-xs">
                          {m.expectedName}
                        </span>
                      </div>
                      <div className="mt-0.5 pl-6 text-[11px] text-muted-foreground">
                        {ROLE_LABELS[m.role]}
                        {m.ambiguous && (
                          <span className="text-warning">
                            {" "}
                            · more than one campaign has this name, pick one
                          </span>
                        )}
                        {!m.match && !m.ambiguous && !overrides[m.role] && (
                          <span className="text-warning"> · not found</span>
                        )}
                        {m.loose && !overrides[m.role] && m.match && (
                          <span className="text-warning">
                            {" "}
                            · matched “{m.match.name}” — only the punctuation
                            differs, check this is the right one
                          </span>
                        )}
                      </div>
                    </div>

                    {(!m.match || m.ambiguous || m.loose) && (
                      <div className="relative shrink-0 sm:w-64">
                        <select
                          className="pv-input appearance-none pr-9 text-xs"
                          value={overrides[m.role] ?? ""}
                          onChange={(e) =>
                            setOverrides((prev) => ({
                              ...prev,
                              [m.role]: e.target.value,
                            }))
                          }
                        >
                          <option value="">Pick manually…</option>
                          {parents
                            .filter((c) => c.id !== sourceId)
                            .map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                        </select>
                        <ChevronDownIcon
                          size={14}
                          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {hasDuplicateRole && (
              <p className="mt-3 text-xs text-danger">
                The same campaign is selected more than once — each role needs its
                own campaign, or leads would be moved into the wrong one.
              </p>
            )}

            <label className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={skipOptOut}
                onChange={(e) => setSkipOptOut(e.target.checked)}
              />
              <span>
                Skip the opt-out copy step — I already added the opt-out line to
                step 1 of both Opt Out campaigns myself.
              </span>
            </label>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger">
            <AlertIcon size={16} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="pv-btn-primary disabled:opacity-50"
            disabled={!canStart}
            onClick={handleStart}
          >
            {starting ? <Spinner /> : <LayersIcon size={16} />}
            Start
          </button>
          {activeJob && (
            <span className="text-xs text-muted-foreground">
              A job is already running — it has to finish before another can
              start.
            </span>
          )}
          {!activeJob && source && !allRolesFilled && (
            <span className="text-xs text-muted-foreground">
              All three companion campaigns need to be matched first.
            </span>
          )}
        </div>
      </div>

      {/* Jobs */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold">Jobs</h2>
        {jobs.length === 0 ? (
          <EmptyState icon={<LayersIcon />} title="No jobs yet">
            Pick the original campaign, confirm the other three, and start — the
            run keeps going even if you close this tab.
          </EmptyState>
        ) : (
          jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              onAbort={async (id) => {
                try {
                  await abortCampaignTypes(id);
                  await refreshJobs();
                } catch (err) {
                  setError(errMessage(err));
                }
              }}
              onRemove={async (id) => {
                try {
                  await deleteCampaignTypesJob(id);
                  await refreshJobs();
                } catch (err) {
                  setError(errMessage(err));
                }
              }}
            />
          ))
        )}
      </div>

      {toast && (
        <div className="fixed bottom-5 right-5 z-50 animate-fade-in">
          <div className="flex items-center gap-3 rounded-xl border border-success/40 bg-success/15 px-4 py-3 shadow-card backdrop-blur">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-success/20 text-success">
              <CheckIcon size={14} />
            </span>
            <span className="text-sm font-medium text-success">{toast}</span>
            <button
              type="button"
              onClick={() => setToast(null)}
              className="ml-1 text-success/70 transition hover:text-success"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function errMessage(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  return err instanceof Error ? err.message : "Something went wrong";
}
