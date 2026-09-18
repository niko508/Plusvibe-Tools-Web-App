"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Workspace, CampaignSummary } from "@/lib/plusvibe-types";
import type { FollowUpTemplate } from "@/lib/follow-ups/templates";
import { OFFER_PLACEHOLDER, hasPlaceholder } from "@/lib/follow-ups/templates";
import {
  fetchWorkspaces,
  fetchCampaigns,
  fetchFollowUpTemplates,
  saveFollowUpTemplates,
  applyFollowUps,
  ApiClientError,
  type FollowUpPlan,
} from "@/lib/api-client";
import { useApiKey } from "@/lib/use-api-key";
import { formatNumber } from "@/lib/format";
import { ConnectPrompt } from "@/components/connect-prompt";
import { Spinner } from "@/components/ui";
import {
  AlertIcon,
  CheckIcon,
  ChevronDownIcon,
  RefreshIcon,
  PenIcon,
} from "@/components/icons";
import { TemplatesView } from "./templates-view";

type View = "run" | "templates";

export function FollowUpsTool() {
  const { hasKey, ready } = useApiKey();
  const [view, setView] = useState<View>("run");

  // Templates
  const [templates, setTemplates] = useState<FollowUpTemplate[]>([]);
  const [savedSnapshot, setSavedSnapshot] = useState<string>("[]");
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Run
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [workspacesLoading, setWorkspacesLoading] = useState(false);
  const [campaigns, setCampaigns] = useState<CampaignSummary[] | null>(null);
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [campaignId, setCampaignId] = useState("");
  const [offer, setOffer] = useState("");
  const [waitTime, setWaitTime] = useState("3");

  const [plan, setPlan] = useState<FollowUpPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const applyLock = useRef(false);

  const dirty = JSON.stringify(templates) !== savedSnapshot;

  // --- Loading -------------------------------------------------------------
  const loadTemplates = useCallback(async () => {
    setTemplatesLoading(true);
    try {
      const { templates: list } = await fetchFollowUpTemplates();
      setTemplates(list);
      setSavedSnapshot(JSON.stringify(list));
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setTemplatesLoading(false);
    }
  }, []);

  const loadWorkspaces = useCallback(async () => {
    setWorkspacesLoading(true);
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

  useEffect(() => {
    if (ready && hasKey) {
      void loadWorkspaces();
      void loadTemplates();
    }
  }, [ready, hasKey, loadWorkspaces, loadTemplates]);

  const loadCampaigns = useCallback(async (wsId: string) => {
    setCampaignsLoading(true);
    setCampaigns(null);
    setCampaignId("");
    setPlan(null);
    try {
      const { campaigns: list } = await fetchCampaigns({ workspace_id: wsId });
      setCampaigns(list);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setCampaignsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (workspaceId) void loadCampaigns(workspaceId);
  }, [workspaceId, loadCampaigns]);

  // --- Derived -------------------------------------------------------------
  // Sub-sequences are separate campaign records; follow-ups go on the parent.
  const parents = useMemo(
    () => (campaigns ?? []).filter((c) => c.campaignType !== "subseq"),
    [campaigns]
  );
  const nonEmpty = templates.filter((t) => t.body.trim());
  const missingPlaceholder = nonEmpty.filter((t) => !hasPlaceholder(t.body)).length;
  const canRun =
    !!workspaceId && !!campaignId && !!offer.trim() && nonEmpty.length > 0 && !busy;

  // --- Actions -------------------------------------------------------------
  async function handleSaveTemplates() {
    setSaving(true);
    setError(null);
    try {
      const { templates: saved } = await saveFollowUpTemplates(templates);
      setTemplates(saved);
      setSavedSnapshot(JSON.stringify(saved));
      setToast("Templates saved");
      setTimeout(() => setToast(null), 3000);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function run(dryRun: boolean) {
    if (!canRun || applyLock.current) return;
    applyLock.current = true;
    setBusy(true);
    setError(null);
    if (!dryRun) setPlan(null);
    try {
      const wt = Number(waitTime);
      const result = await applyFollowUps({
        workspace_id: workspaceId!,
        campaign_id: campaignId,
        offer: offer.trim(),
        templates: nonEmpty,
        waitTime: Number.isFinite(wt) && wt >= 0 ? wt : undefined,
        dryRun,
      });
      setPlan(result);
      if (!dryRun && result.applied) {
        setToast(
          `${result.adding.length} follow-up${result.adding.length === 1 ? "" : "s"} added to step 2`
        );
        setTimeout(() => setToast(null), 5000);
      }
    } catch (err) {
      setError(errMessage(err));
    } finally {
      applyLock.current = false;
      setBusy(false);
    }
  }

  // --- Render --------------------------------------------------------------
  if (!ready) return <div className="pv-card h-40 animate-pulse" />;
  if (!hasKey) return <ConnectPrompt onConnected={loadWorkspaces} />;

  return (
    <div className="space-y-5">
      {/* View switch */}
      <div className="flex items-center gap-2">
        {(["run", "templates"] as View[]).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={`pv-chip ${view === v ? "pv-chip-active" : "hover:text-foreground"}`}
          >
            {v === "run" ? "Run" : `Templates (${templates.length})`}
          </button>
        ))}
        {dirty && view !== "templates" && (
          <span className="text-xs text-warning">unsaved template changes</span>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          <AlertIcon size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {view === "templates" ? (
        <TemplatesView
          templates={templates}
          setTemplates={setTemplates}
          onSave={handleSaveTemplates}
          saving={saving}
          dirty={dirty}
          loading={templatesLoading}
        />
      ) : (
        <>
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
                  Campaign
                </label>
                <div className="relative">
                  <select
                    className="pv-input appearance-none pr-9"
                    value={campaignId}
                    disabled={campaignsLoading || parents.length === 0}
                    onChange={(e) => {
                      setCampaignId(e.target.value);
                      setPlan(null);
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

            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Service offering / offer
              </label>
              <input
                type="text"
                className="pv-input"
                placeholder="e.g. helping tree removal companies book more jobs"
                value={offer}
                onChange={(e) => {
                  setOffer(e.target.value);
                  setPlan(null);
                }}
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                Replaces <span className="font-mono">{OFFER_PLACEHOLDER}</span> in
                every template. Write it so it reads on from “I reached out
                earlier about …”.
              </p>
            </div>

            <div className="flex flex-wrap items-end gap-4">
              <div className="w-40">
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  Wait before step 2
                </label>
                <input
                  type="number"
                  min={0}
                  className="pv-input"
                  value={waitTime}
                  onChange={(e) => setWaitTime(e.target.value)}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Only used if step 2 doesn&apos;t exist yet.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="pv-btn-ghost disabled:opacity-50"
                  disabled={!canRun}
                  onClick={() => run(true)}
                >
                  {busy ? <Spinner /> : <RefreshIcon size={16} />}
                  Preview
                </button>
                <button
                  type="button"
                  className="pv-btn-primary disabled:opacity-50"
                  disabled={!canRun}
                  onClick={() => run(false)}
                >
                  {busy ? <Spinner /> : <PenIcon size={16} />}
                  Add {formatNumber(nonEmpty.length)} follow-up
                  {nonEmpty.length === 1 ? "" : "s"} to step 2
                </button>
              </div>
            </div>

            {nonEmpty.length === 0 && !templatesLoading && (
              <p className="text-xs text-warning">
                No templates yet — add some in the Templates view.
              </p>
            )}
            {missingPlaceholder > 0 && (
              <p className="text-xs text-warning">
                {missingPlaceholder} template
                {missingPlaceholder === 1 ? "" : "s"} without the placeholder will
                be added unchanged.
              </p>
            )}
            {dirty && (
              <p className="text-xs text-warning">
                You have unsaved template edits — they&apos;ll still be used for
                this run, but save them so they stick.
              </p>
            )}
          </div>

          {plan && <PlanCard plan={plan} />}
        </>
      )}

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

function PlanCard({ plan }: { plan: FollowUpPlan }) {
  return (
    <div className="pv-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">
          {plan.applied ? "Added to step 2" : "Preview"}
        </h2>
        <span className="text-xs text-muted-foreground">
          {plan.campaignName}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Already on step 2" value={plan.existing} />
        <Stat
          label={plan.applied ? "Added" : "To add"}
          value={plan.adding.length}
          tone="success"
        />
        <Stat label="Skipped as duplicates" value={plan.skipped.length} />
        <Stat label="Step 2 wait" value={plan.waitTime} />
      </div>

      {plan.stepCreated && (
        <p className="mt-3 text-xs text-muted-foreground">
          {plan.applied ? "Created" : "Will create"} step 2 — the campaign only
          had step 1.
        </p>
      )}
      {plan.droppedDeleted > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Dropped {plan.droppedDeleted} variation
          {plan.droppedDeleted === 1 ? "" : "s"} Plusvibe had already deleted, so
          they aren&apos;t written back as live copy.
        </p>
      )}
      {plan.unchanged && (
        <p className="mt-2 text-xs text-muted-foreground">
          Every template is already on step 2 — nothing to do.
        </p>
      )}
      {plan.applied && plan.verified === false && (
        <p className="mt-2 flex gap-1.5 text-xs text-danger">
          <AlertIcon size={13} className="mt-0.5 shrink-0" />
          <span>
            Expected {plan.expected} variations on step 2 after the write but
            found {plan.actual}. Check the campaign in Plusvibe.
          </span>
        </p>
      )}
      {plan.warnings.map((w, i) => (
        <p key={i} className="mt-2 flex gap-1.5 text-xs text-warning">
          <AlertIcon size={13} className="mt-0.5 shrink-0" />
          <span>{w}</span>
        </p>
      ))}

      {plan.adding.length > 0 && (
        <div className="pv-scroll mt-4 max-h-72 overflow-y-auto rounded-xl border border-border">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="px-3 py-2 font-medium">Variant</th>
                <th className="px-3 py-2 font-medium">From template</th>
                <th className="px-3 py-2 font-medium">Preview</th>
              </tr>
            </thead>
            <tbody>
              {plan.adding.map((row) => (
                <tr
                  key={row.variation}
                  className="border-b border-border/70 last:border-0"
                >
                  <td className="px-3 py-2 font-medium">{row.variation}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    #{row.position}
                    {row.replacements === 0 && (
                      <span className="text-warning"> · no offer</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {row.preview}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "success";
}) {
  return (
    <div className="rounded-xl border border-border p-2.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div
        className={`mt-0.5 text-lg font-semibold tabular-nums ${
          tone === "success" ? "text-success" : ""
        }`}
      >
        {formatNumber(value)}
      </div>
    </div>
  );
}

function errMessage(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  return err instanceof Error ? err.message : "Something went wrong";
}
