"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Workspace, CampaignSummary, CampaignDetail } from "@/lib/plusvibe-types";
import {
  fetchWorkspaces,
  fetchCampaigns,
  fetchCampaign,
  runCopyCampaign,
  ApiClientError,
  type CopyCampaignResponse,
} from "@/lib/api-client";
import { useApiKey } from "@/lib/use-api-key";
import { formatNumber } from "@/lib/format";
import { ConnectPrompt } from "@/components/connect-prompt";
import { EmptyState, Spinner } from "@/components/ui";
import {
  AlertIcon,
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  LayersIcon,
} from "@/components/icons";
import {
  countVariations,
  defaultName,
  describePlan,
  planProblems,
  planWarnings,
  shapeOf,
} from "@/lib/copy-campaign/plan";

// Copy Campaign to Other Workspace.
//
// The destination campaign is the TEMPLATE: it is duplicated inside its own
// workspace so its settings, schedule, sender accounts and sub-sequences come
// along — none of which can cross a workspace boundary. The source campaign
// supplies the email copy, which is written over the new campaign's parent
// sequences. The sub-sequences keep the destination's own content.

export function CopyCampaignTool() {
  const { hasKey, ready } = useApiKey();

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(false);

  const [sourceWs, setSourceWs] = useState("");
  const [sourceCampaigns, setSourceCampaigns] = useState<CampaignSummary[]>([]);
  const [sourceCampaignsLoading, setSourceCampaignsLoading] = useState(false);
  const [sourceCampaignId, setSourceCampaignId] = useState("");
  const [sourceDetail, setSourceDetail] = useState<CampaignDetail | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);

  const [destWs, setDestWs] = useState("");
  const [destCampaigns, setDestCampaigns] = useState<CampaignSummary[]>([]);
  const [destCampaignsLoading, setDestCampaignsLoading] = useState(false);
  const [destCampaignId, setDestCampaignId] = useState("");
  const [destSubs, setDestSubs] = useState<CampaignSummary[]>([]);
  const [destSubsequences, setDestSubsequences] = useState<number | null>(null);

  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [withSubsequences, setWithSubsequences] = useState(true);

  const [armed, setArmed] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CopyCampaignResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // --- Workspaces ----------------------------------------------------------
  const loadWorkspaces = useCallback(async () => {
    setWorkspacesLoading(true);
    setError(null);
    try {
      const res = await fetchWorkspaces();
      setWorkspaces(res.workspaces ?? []);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setWorkspacesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (ready && hasKey) void loadWorkspaces();
  }, [ready, hasKey, loadWorkspaces]);

  // --- Campaigns per side --------------------------------------------------
  useEffect(() => {
    setSourceCampaigns([]);
    setSourceCampaignId("");
    setSourceDetail(null);
    if (!sourceWs) return;
    let cancelled = false;
    setSourceCampaignsLoading(true);
    fetchCampaigns({ workspace_id: sourceWs, campaign_type: "parent" })
      .then((res) => {
        if (!cancelled) setSourceCampaigns(res.campaigns ?? []);
      })
      .catch((err) => {
        if (!cancelled) setError(errMessage(err));
      })
      .finally(() => {
        if (!cancelled) setSourceCampaignsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sourceWs]);

  useEffect(() => {
    setDestCampaigns([]);
    setDestCampaignId("");
    setDestSubsequences(null);
    if (!destWs) return;
    let cancelled = false;
    setDestCampaignsLoading(true);
    Promise.all([
      fetchCampaigns({ workspace_id: destWs, campaign_type: "parent" }),
      // Sub-sequences, so the preview can say how many come across.
      fetchCampaigns({ workspace_id: destWs, campaign_type: "subseq" }).catch(
        () => ({ campaigns: [] as CampaignSummary[] })
      ),
    ])
      .then(([parents, subs]) => {
        if (cancelled) return;
        setDestCampaigns(parents.campaigns ?? []);
        setDestSubs(subs.campaigns ?? []);
      })
      .catch((err) => {
        if (!cancelled) setError(errMessage(err));
      })
      .finally(() => {
        if (!cancelled) setDestCampaignsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [destWs]);

  useEffect(() => {
    if (!destCampaignId) {
      setDestSubsequences(null);
      return;
    }
    setDestSubsequences(
      destSubs.filter((c) => c.parentCampId === destCampaignId).length
    );
  }, [destCampaignId, destSubs]);

  // --- The source's copy, so the preview shows what travels ----------------
  useEffect(() => {
    setSourceDetail(null);
    if (!sourceWs || !sourceCampaignId) return;
    let cancelled = false;
    setSourceLoading(true);
    fetchCampaign({ workspace_id: sourceWs, campaign_id: sourceCampaignId })
      .then((d) => {
        if (cancelled) return;
        setSourceDetail(d);
        // The copy takes the source's name unless one was typed.
        if (!nameTouched) setName(defaultName(d.name));
      })
      .catch((err) => {
        if (!cancelled) setError(errMessage(err));
      })
      .finally(() => {
        if (!cancelled) setSourceLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // nameTouched is deliberately not a dependency: re-running on every
    // keystroke would refetch the campaign.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceWs, sourceCampaignId]);

  // --- Derived -------------------------------------------------------------
  const selection = {
    sourceWorkspaceId: sourceWs,
    sourceCampaignId,
    destWorkspaceId: destWs,
    destCampaignId,
    name,
  };
  const shape = useMemo(
    () => (sourceDetail ? shapeOf(sourceDetail.steps.map((s) => ({ step: s.step, variations: s.variations }))) : []),
    [sourceDetail]
  );
  const problems = planProblems(selection, {
    sourceSteps: sourceDetail ? shape.length : undefined,
  });
  const warnings = planWarnings(selection);
  const ready2go = problems.length === 0 && !running;

  const sourceCampaignName =
    sourceCampaigns.find((c) => c.id === sourceCampaignId)?.name ?? "";
  const destCampaignName =
    destCampaigns.find((c) => c.id === destCampaignId)?.name ?? "";
  const destWorkspaceName = workspaces.find((w) => w._id === destWs)?.name ?? "";

  async function run() {
    if (!ready2go) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await runCopyCampaign(
        { ...selection, name: name.trim(), duplicateSubsequences: withSubsequences },
        controller.signal
      );
      setResult(res);
      setArmed(false);
    } catch (err) {
      setError(errMessage(err));
      setArmed(false);
    } finally {
      setRunning(false);
    }
  }

  // --- Render --------------------------------------------------------------
  if (!ready) return <div className="pv-card h-40 animate-pulse" />;
  if (!hasKey) return <ConnectPrompt onConnected={loadWorkspaces} />;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_auto_1fr]">
        {/* Source */}
        <div className="pv-card min-w-0 p-4 sm:p-5">
          <h2 className="text-sm font-semibold">Copy from</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            The campaign whose email copy you want.
          </p>
          <div className="mt-4 space-y-3">
            <Select
              label="Source workspace"
              value={sourceWs}
              onChange={setSourceWs}
              loading={workspacesLoading}
              options={workspaces.map((w) => ({ value: w._id, label: w.name }))}
              placeholder="Pick a workspace"
            />
            <Select
              label="Source campaign"
              value={sourceCampaignId}
              onChange={(v) => {
                setSourceCampaignId(v);
                setNameTouched(false);
              }}
              loading={sourceCampaignsLoading}
              disabled={!sourceWs}
              options={sourceCampaigns.map((c) => ({
                value: c.id,
                label: `${c.name}${c.sequenceSteps ? ` · ${c.sequenceSteps} step${c.sequenceSteps === 1 ? "" : "s"}` : ""}`,
              }))}
              placeholder={sourceWs ? "Pick a campaign" : "Pick a workspace first"}
            />
          </div>

          {sourceLoading && (
            <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner size={12} />
              Reading the campaign…
            </p>
          )}
          {sourceDetail && !sourceLoading && (
            <div className="mt-4 rounded-xl border border-border p-3" data-source-copy>
              <p className="text-xs font-medium text-muted-foreground">
                What travels: {formatNumber(shape.length)} step
                {shape.length === 1 ? "" : "s"},{" "}
                {formatNumber(countVariations(shape))} variation
                {countVariations(shape) === 1 ? "" : "s"}
              </p>
              <ul className="mt-2 space-y-1 text-xs">
                {sourceDetail.steps.map((s) => (
                  <li key={s.step} className="flex items-center justify-between gap-3">
                    {/* No subject line here: a spintax subject runs to
                        thousands of characters and would widen the page. */}
                    <span className="min-w-0 truncate text-muted-foreground">
                      Step {s.step}
                    </span>
                    <span className="shrink-0 tabular-nums">
                      {s.variations.length}
                    </span>
                  </li>
                ))}
              </ul>
              {sourceDetail.warnings.map((w) => (
                <p key={w} className="mt-2 text-xs text-warning">
                  {w}
                </p>
              ))}
            </div>
          )}
        </div>

        <div className="hidden items-center justify-center lg:flex">
          <ArrowRightIcon className="text-muted-foreground" />
        </div>

        {/* Destination */}
        <div className="pv-card min-w-0 p-4 sm:p-5">
          <h2 className="text-sm font-semibold">Copy into</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            The campaign whose settings and sub-sequences the copy is built on.
          </p>
          <div className="mt-4 space-y-3">
            <Select
              label="Destination workspace"
              value={destWs}
              onChange={setDestWs}
              loading={workspacesLoading}
              options={workspaces.map((w) => ({ value: w._id, label: w.name }))}
              placeholder="Pick a workspace"
            />
            <Select
              label="Destination campaign"
              value={destCampaignId}
              onChange={setDestCampaignId}
              loading={destCampaignsLoading}
              disabled={!destWs}
              options={destCampaigns.map((c) => ({
                value: c.id,
                label: `${c.name}${c.sequenceSteps ? ` · ${c.sequenceSteps} step${c.sequenceSteps === 1 ? "" : "s"}` : ""}`,
              }))}
              placeholder={destWs ? "Pick a campaign" : "Pick a workspace first"}
            />
          </div>

          {destCampaignId && (
            <div className="mt-4 rounded-xl border border-border p-3" data-dest-summary>
              <p className="text-xs text-muted-foreground">
                Its settings, schedule and sender accounts come across.{" "}
                {destSubsequences === null
                  ? ""
                  : destSubsequences > 0
                    ? `${formatNumber(destSubsequences)} sub-sequence${destSubsequences === 1 ? "" : "s"} found.`
                    : "It has no sub-sequences."}
              </p>
              <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={withSubsequences}
                  aria-label="Bring the sub-sequences across"
                  onChange={(e) => setWithSubsequences(e.target.checked)}
                />
                Bring the sub-sequences across
              </label>
            </div>
          )}
        </div>
      </div>

      {/* Name + run */}
      <div className="pv-card p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="min-w-[240px] flex-1">
            <label
              className="mb-1.5 block text-xs font-medium text-muted-foreground"
              htmlFor="cc-name"
            >
              Name for the new campaign
            </label>
            <input
              id="cc-name"
              aria-label="Name for the new campaign"
              className="pv-input"
              value={name}
              placeholder="Pick a source campaign to name it after"
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
            />
          </div>
          <div className="flex items-center gap-2">
            {armed && (
              <button type="button" className="pv-btn-ghost" onClick={() => setArmed(false)}>
                Cancel
              </button>
            )}
            <button
              type="button"
              data-run
              className={`pv-btn ${armed ? "bg-danger text-white shadow-soft hover:brightness-110" : "pv-btn-primary"} disabled:opacity-50`}
              disabled={!ready2go}
              onClick={() => (armed ? void run() : setArmed(true))}
            >
              {running ? <Spinner /> : <CopyIcon size={16} />}
              {running
                ? "Copying…"
                : armed
                  ? "Really create it? Click again"
                  : "Create the copy"}
            </button>
          </div>
        </div>

        {problems.length > 0 && (
          <ul className="mt-3 space-y-1">
            {problems.map((p) => (
              <li key={p} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <AlertIcon size={12} />
                {p}
              </li>
            ))}
          </ul>
        )}
        {warnings.map((w) => (
          <p key={w} className="mt-2 flex items-center gap-1.5 text-xs text-warning">
            <AlertIcon size={12} />
            {w}
          </p>
        ))}
        {problems.length === 0 && sourceDetail && (
          <p className="mt-3 text-sm text-muted-foreground" data-plan>
            {describePlan({
              sourceCampaign: sourceCampaignName,
              destCampaign: destCampaignName,
              destWorkspace: destWorkspaceName,
              name: name.trim(),
              steps: shape.length,
              variations: countVariations(shape),
              subsequences: withSubsequences,
            })}
          </p>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          <AlertIcon size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {result ? (
        <div className="pv-card p-4 sm:p-5" data-result>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                result.verified
                  ? "bg-success/10 text-success"
                  : "bg-warning/10 text-warning"
              }`}
            >
              {result.verified ? "Copied" : "Copied with problems"}
            </span>
            <span className="text-sm font-medium">{result.name}</span>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="Steps copied" value={result.stepsCopied} />
            <Metric label="Variations copied" value={result.variationsCopied} />
            <Metric label="Sub-sequences" value={result.subsequences} />
            <Metric label="Deleted left out" value={result.droppedDeleted} />
          </div>
          {result.verified && (
            <p className="mt-3 flex items-center gap-1.5 text-xs text-success">
              <CheckIcon size={13} />
              Read back from Plusvibe and it matches what was sent.
            </p>
          )}
          {result.problems.map((p) => (
            <p key={p} className="mt-2 text-xs text-danger">
              {p}
            </p>
          ))}
          {result.warnings.map((w) => (
            <p key={w} className="mt-2 text-xs text-warning">
              {w}
            </p>
          ))}
          <p className="mt-3 text-xs text-muted-foreground">
            The copy is a draft in {destWorkspaceName || "the destination workspace"}.
            Check it in Plusvibe, then activate it there.
          </p>
        </div>
      ) : (
        !running && (
          <EmptyState icon={<LayersIcon />} title="Nothing copied yet">
            Pick both sides above. The destination campaign is duplicated where
            it already lives, so its settings and sub-sequences survive, and
            only the parent&apos;s email copy is replaced.
          </EmptyState>
        )
      )}
    </div>
  );
}

// --- Small pieces ----------------------------------------------------------

function Select({
  label,
  value,
  onChange,
  options,
  loading,
  disabled,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  loading?: boolean;
  disabled?: boolean;
  placeholder: string;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <div className="relative">
        <select
          className="pv-input appearance-none pr-9"
          value={value}
          disabled={disabled || loading}
          aria-label={label}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">{loading ? "Loading…" : placeholder}</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDownIcon
          size={16}
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-lg font-semibold tabular-nums">{formatNumber(value)}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function errMessage(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
