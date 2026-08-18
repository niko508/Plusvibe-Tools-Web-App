"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Workspace, CampaignSummary, CampaignDetail } from "@/lib/plusvibe-types";
import {
  fetchWorkspaces,
  fetchCampaigns,
  fetchCampaign,
  addCampaignVariations,
  ApiClientError,
  type AddVariationsResult,
} from "@/lib/api-client";
import { useApiKey } from "@/lib/use-api-key";
import { formatNumber } from "@/lib/format";
import { nextVariationLabels, MAX_VARIATIONS_PER_STEP } from "@/lib/variation-labels";
import { ConnectPrompt } from "@/components/connect-prompt";
import { Spinner, EmptyState } from "@/components/ui";
import {
  LayersIcon,
  AlertIcon,
  RefreshIcon,
  ChevronDownIcon,
  CheckIcon,
} from "@/components/icons";
import { parseVariants } from "./parse";

// The API has no DRAFT status: a never-launched campaign comes back as
// INACTIVE (or blank). Bucket client-side rather than using the `status` query
// filter, which doesn't accept INACTIVE at all.
type Bucket = "active" | "draft" | "paused" | "completed" | "archived";

function statusBucket(status: string): Bucket {
  const s = (status ?? "").toUpperCase();
  if (s === "ACTIVE" || s === "RUNNING") return "active";
  if (s === "PAUSED") return "paused";
  if (s === "COMPLETED") return "completed";
  if (s === "ARCHIVED") return "archived";
  return "draft"; // INACTIVE, DRAFT, ERROR, empty, anything unknown
}

const BUCKET_LABEL: Record<Bucket, string> = {
  active: "Active",
  draft: "Draft",
  paused: "Paused",
  completed: "Completed",
  archived: "Archived",
};

// Order the hidden-count breakdown reads in.
const HIDDEN_ORDER: Bucket[] = ["paused", "completed", "archived"];

export function CopyVariationsTool() {
  const { hasKey, ready } = useApiKey();

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(false);
  const [workspaceId, setWorkspaceId] = useState("");

  const [campaigns, setCampaigns] = useState<CampaignSummary[] | null>(null);
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [campaignId, setCampaignId] = useState("");

  const [detail, setDetail] = useState<CampaignDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [step, setStep] = useState<number | null>(null);

  const [raw, setRaw] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);

  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<AddVariationsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const applyLock = useRef(false);

  // --- Workspaces ----------------------------------------------------------
  const loadWorkspaces = useCallback(async () => {
    setWorkspacesLoading(true);
    setError(null);
    try {
      const res = await fetchWorkspaces();
      const list = res.workspaces ?? [];
      setWorkspaces(list);
      setWorkspaceId((prev) => prev || list[0]?._id || "");
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setWorkspacesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (ready && hasKey) void loadWorkspaces();
  }, [ready, hasKey, loadWorkspaces]);

  // --- Campaigns for the workspace -----------------------------------------
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    const controller = new AbortController();
    setCampaignsLoading(true);
    setCampaigns(null);
    setCampaignId("");
    setDetail(null);
    setStep(null);
    setResult(null);
    setError(null);
    fetchCampaigns({ workspace_id: workspaceId }, controller.signal)
      .then((res) => {
        if (cancelled) return;
        setCampaigns(res.campaigns ?? []);
      })
      .catch((err) => {
        if (cancelled || isAbort(err)) return;
        setError(errMessage(err));
      })
      .finally(() => {
        if (!cancelled) setCampaignsLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [workspaceId]);

  // The API is asked for campaign_type=parent, but filter defensively so a
  // subsequence can never pad the list or the hidden count.
  const allCampaigns = useMemo(
    () => (campaigns ?? []).filter((c) => c.campaignType !== "subseq"),
    [campaigns]
  );

  const visibleCampaigns = useMemo(() => {
    if (showAll) return allCampaigns;
    return allCampaigns.filter((c) => {
      const b = statusBucket(c.status);
      return b === "active" || b === "draft";
    });
  }, [allCampaigns, showAll]);

  const hiddenCount = allCampaigns.length - visibleCampaigns.length;

  // Broken down by status so the total can be reconciled against Plusvibe's own
  // campaign list — the API returns archived campaigns that the UI hides.
  const hiddenBreakdown = useMemo(() => {
    const counts = new Map<Bucket, number>();
    for (const c of allCampaigns) {
      const b = statusBucket(c.status);
      if (b === "active" || b === "draft") continue;
      counts.set(b, (counts.get(b) ?? 0) + 1);
    }
    return HIDDEN_ORDER.filter((b) => counts.has(b)).map(
      (b) => `${counts.get(b)} ${BUCKET_LABEL[b].toLowerCase()}`
    );
  }, [allCampaigns]);

  // --- Campaign detail ------------------------------------------------------
  const loadDetail = useCallback(
    async (id: string) => {
      if (!workspaceId || !id) return;
      setDetailLoading(true);
      setDetail(null);
      setStep(null);
      setResult(null);
      setError(null);
      try {
        const d = await fetchCampaign({
          workspace_id: workspaceId,
          campaign_id: id,
        });
        setDetail(d);
        setStep(d.steps[0]?.step ?? null);
      } catch (err) {
        setError(errMessage(err));
      } finally {
        setDetailLoading(false);
      }
    },
    [workspaceId]
  );

  useEffect(() => {
    if (campaignId) void loadDetail(campaignId);
  }, [campaignId, loadDetail]);

  // --- Parse ----------------------------------------------------------------
  const parsed = useMemo(() => parseVariants(raw), [raw]);

  const activeStep = detail?.steps.find((s) => s.step === step) ?? null;
  const usedLabels = activeStep
    ? [
        ...activeStep.variations.map((v) => v.variation),
        ...activeStep.hiddenVariations,
      ]
    : [];
  const predictedLabels = nextVariationLabels(usedLabels, parsed.variants.length);
  const roomLeft = MAX_VARIATIONS_PER_STEP - usedLabels.length;
  const overCapacity = parsed.variants.length > roomLeft;

  const canApply =
    !!detail &&
    !!activeStep &&
    parsed.variants.length > 0 &&
    !overCapacity &&
    !applying;

  // --- Apply ----------------------------------------------------------------
  async function handleApply() {
    if (!canApply || !activeStep || !detail) return;
    // Ref guard, not state: two fast clicks can both pass the `applying` check
    // before React re-renders, and a double-apply would duplicate the copy.
    if (applyLock.current) return;
    applyLock.current = true;
    setApplying(true);
    setError(null);
    setResult(null);
    try {
      const res = await addCampaignVariations({
        workspace_id: workspaceId,
        campaign_id: detail.id,
        step: activeStep.step,
        variants: parsed.variants.map((v) => ({
          name: v.name || `Variant ${v.number ?? v.position}`,
          body: v.html,
        })),
        expectedVariationCount: activeStep.variations.length,
      });
      setResult(res);
      setRaw("");
      // Refresh so the step shows its new variation count.
      await loadDetail(detail.id);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      applyLock.current = false;
      setApplying(false);
    }
  }

  // --- Render ---------------------------------------------------------------
  if (!ready) return <div className="pv-card h-40 animate-pulse" />;
  if (!hasKey) return <ConnectPrompt onConnected={loadWorkspaces} />;

  return (
    <div className="space-y-5">
      {/* Workspace + campaign */}
      <div className="pv-card space-y-4 p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row">
          <div className="min-w-[200px] flex-1">
            <label className="mb-1.5 block text-sm font-medium">Workspace</label>
            <Select
              value={workspaceId}
              disabled={workspacesLoading || workspaces.length === 0}
              onChange={setWorkspaceId}
            >
              {workspacesLoading && <option>Loading…</option>}
              {!workspacesLoading &&
                workspaces.map((w) => (
                  <option key={w._id} value={w._id}>
                    {w.name}
                  </option>
                ))}
            </Select>
          </div>

          <div className="min-w-[240px] flex-[1.4]">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <label className="block text-sm font-medium">Campaign</label>
              {campaignsLoading && <Spinner size={12} />}
            </div>
            <Select
              value={campaignId}
              disabled={campaignsLoading || visibleCampaigns.length === 0}
              onChange={setCampaignId}
            >
              <option value="">
                {campaignsLoading
                  ? "Loading campaigns…"
                  : visibleCampaigns.length === 0
                    ? "No campaigns"
                    : "Select a campaign…"}
              </option>
              {visibleCampaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — {BUCKET_LABEL[statusBucket(c.status)]}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <label className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-accent"
            checked={showAll}
            onChange={(e) => setShowAll(e.target.checked)}
          />
          Show all campaigns
          {allCampaigns.length > 0 && (
            <span>
              · {formatNumber(allCampaigns.length)} in this workspace
              {hiddenCount > 0 &&
                !showAll &&
                ` (${hiddenBreakdown.join(", ")} hidden)`}
            </span>
          )}
        </label>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          <AlertIcon size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {detailLoading && (
        <div className="pv-card flex items-center gap-3 p-4 text-sm text-muted-foreground">
          <Spinner size={14} />
          Loading campaign sequence…
        </div>
      )}

      {/* Step picker + subject */}
      {detail && !detailLoading && (
        <>
          {detail.warnings.map((w, i) => (
            <div
              key={i}
              className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning"
            >
              <AlertIcon size={16} className="mt-0.5 shrink-0" />
              <span>{w}</span>
            </div>
          ))}

          {detail.steps.length > 0 && (
            <div className="pv-card space-y-4 p-4 sm:p-5">
              <div>
                <label className="mb-1.5 block text-sm font-medium">
                  Step to add variants to
                </label>
                <div className="flex flex-wrap gap-2">
                  {detail.steps.map((s) => (
                    <button
                      key={s.step}
                      type="button"
                      onClick={() => setStep(s.step)}
                      className={`rounded-xl border px-3 py-2 text-left text-sm transition ${
                        s.step === step
                          ? "border-accent bg-accent/10"
                          : "border-border hover:bg-muted/50"
                      }`}
                    >
                      <div className="font-medium">Step {s.step}</div>
                      <div className="text-xs text-muted-foreground">
                        {formatNumber(s.variations.length)} variation
                        {s.variations.length === 1 ? "" : "s"}
                        {s.deletedVariations.length > 0 &&
                          ` · ${s.deletedVariations.length} stale`}
                        {s.hiddenVariations.length > 0 &&
                          ` · ${s.hiddenVariations.length} hidden`}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {activeStep && (
                <div>
                  <div className="mb-1.5 flex items-center gap-2 text-sm font-medium">
                    Subject line
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">
                      kept as-is, copied to the new variants
                    </span>
                  </div>
                  {activeStep.subject ? (
                    <div className="pv-scroll max-h-24 overflow-y-auto rounded-xl border border-border bg-muted/40 px-3 py-2 font-mono text-xs">
                      {activeStep.subject}
                    </div>
                  ) : (
                    <div className="rounded-xl border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                      {activeStep.step === 1
                        ? "No subject set on this step — set one in Plusvibe first (step 1 requires a subject)."
                        : "Empty (follow-up step replies in-thread)."}
                    </div>
                  )}
                  <div className="mt-2 text-xs text-muted-foreground">
                    Existing variations:{" "}
                    <span className="font-mono">
                      {activeStep.variations.map((v) => v.variation).join(", ") ||
                        "none"}
                    </span>{" "}
                    · room for {formatNumber(Math.max(0, roomLeft))} more
                  </div>
                </div>
              )}
            </div>
          )}

          {detail.steps.length === 0 && (
            <EmptyState title="No sequence steps">
              This campaign has no steps yet. Add a step with your first variant
              in Plusvibe, then come back.
            </EmptyState>
          )}
        </>
      )}

      {/* Paste box */}
      {detail && detail.steps.length > 0 && !detailLoading && (
        <div className="pv-card space-y-3 p-4 sm:p-5">
          <div>
            <label className="mb-1.5 block text-sm font-medium">Variants</label>
            <p className="mb-2 text-xs text-muted-foreground">
              Paste your variants. Blocks are split on{" "}
              <span className="font-mono">VARIANT n — name</span> headers; the{" "}
              <span className="font-mono">═══</span> rules are ignored. Spintax and
              Liquid tags are preserved exactly.
            </p>
            <textarea
              className="pv-input min-h-[280px] w-full resize-y font-mono text-xs leading-relaxed"
              placeholder={PLACEHOLDER}
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              spellCheck={false}
            />
          </div>

          {parsed.warnings.map((w, i) => (
            <div
              key={i}
              className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning"
            >
              <AlertIcon size={14} className="mt-0.5 shrink-0" />
              <span>{w}</span>
            </div>
          ))}

          {overCapacity && (
            <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
              <AlertIcon size={14} className="mt-0.5 shrink-0" />
              <span>
                {formatNumber(parsed.variants.length)} variants won&apos;t fit —
                this step has room for {formatNumber(Math.max(0, roomLeft))} more
                (the API caps a step at {MAX_VARIATIONS_PER_STEP}).
              </span>
            </div>
          )}

          {parsed.variants.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-border">
              <div className="border-b border-border bg-muted/40 px-3 py-2 text-xs font-medium">
                {formatNumber(parsed.variants.length)} variant
                {parsed.variants.length === 1 ? "" : "s"} ready
                {!overCapacity && predictedLabels.length > 0 && (
                  <span className="font-normal text-muted-foreground">
                    {" "}
                    · will be added as{" "}
                    <span className="font-mono">
                      {predictedLabels.join(", ")}
                    </span>
                  </span>
                )}
              </div>
              <div className="pv-scroll max-h-72 overflow-y-auto">
                {parsed.variants.map((v, i) => (
                  <div key={v.position} className="border-b border-border/70 last:border-0">
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-muted/50"
                      onClick={() =>
                        setExpanded(expanded === v.position ? null : v.position)
                      }
                    >
                      <span className="w-8 shrink-0 font-mono text-muted-foreground">
                        {predictedLabels[i] ?? "—"}
                      </span>
                      <span className="flex-1 truncate font-medium">
                        {v.name || `Variant ${v.number ?? v.position}`}
                      </span>
                      <span className="shrink-0 text-muted-foreground">
                        {formatNumber(v.body.length)} chars
                      </span>
                      <ChevronDownIcon
                        size={14}
                        className={`shrink-0 text-muted-foreground transition ${
                          expanded === v.position ? "rotate-180" : ""
                        }`}
                      />
                    </button>
                    {expanded === v.position && (
                      <pre className="pv-scroll max-h-64 overflow-auto whitespace-pre-wrap break-words bg-muted/30 px-3 py-2 font-mono text-[11px] leading-relaxed">
                        {v.body}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button
              type="button"
              className="pv-btn-primary"
              disabled={!canApply}
              onClick={handleApply}
            >
              {applying ? <Spinner /> : <LayersIcon size={16} />}
              Add {formatNumber(parsed.variants.length)} variant
              {parsed.variants.length === 1 ? "" : "s"} to step {step ?? "—"}
            </button>
            <span className="text-xs text-muted-foreground">
              Existing variants and the subject line are left untouched.
            </span>
          </div>
        </div>
      )}

      {/* Result */}
      {result && (
        <div
          className={`pv-card p-4 sm:p-5 ${
            result.verified ? "border-success/40" : "border-warning/40"
          }`}
        >
          <div className="flex items-start gap-2">
            {result.verified ? (
              <CheckIcon size={18} className="mt-0.5 shrink-0 text-success" />
            ) : (
              <AlertIcon size={18} className="mt-0.5 shrink-0 text-warning" />
            )}
            <div className="text-sm">
              {result.verified ? (
                <>
                  {result.added.length > 0 ? (
                    <>
                      Added{" "}
                      <strong>
                        {formatNumber(result.added.length)} variant
                        {result.added.length === 1 ? "" : "s"}
                      </strong>{" "}
                      to step {result.step} as{" "}
                      <span className="font-mono">
                        {result.added.map((a) => a.variation).join(", ")}
                      </span>
                      . The step went from {formatNumber(result.before)} to{" "}
                      {formatNumber(result.actual)} variations.
                    </>
                  ) : (
                    <>
                      Nothing to add — every variant in the paste is already on
                      step {result.step}. It still has{" "}
                      {formatNumber(result.actual)} variations.
                    </>
                  )}
                  {result.skipped?.length > 0 && (
                    <div className="mt-1 text-muted-foreground">
                      {formatNumber(result.skipped.length)} skipped as duplicate
                      {result.skipped.length === 1 ? "" : "s"} of copy already on
                      the step.
                    </div>
                  )}
                  {result.droppedDeleted > 0 && (
                    <div className="mt-1 text-muted-foreground">
                      Also cleared {formatNumber(result.droppedDeleted)} stale
                      variation
                      {result.droppedDeleted === 1 ? "" : "s"} that Plusvibe had
                      deleted but the API was still returning.
                    </div>
                  )}
                </>
              ) : (
                <>
                  The write went through but verification didn&apos;t match:
                  expected {formatNumber(result.expected)} variations on step{" "}
                  {result.step}, found {formatNumber(result.actual)}. Check the
                  campaign in Plusvibe before adding more.
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {campaigns && campaigns.length === 0 && !campaignsLoading && (
        <EmptyState icon={<LayersIcon />} title="No campaigns">
          This workspace has no campaigns yet.
        </EmptyState>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Select({
  value,
  onChange,
  disabled,
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="relative">
      <select
        className="pv-input appearance-none pr-9"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
      <ChevronDownIcon
        size={16}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  );
}

const PLACEHOLDER = `VARIANT 1 — Poke-the-bear
═══════════════════════════════════════════

{% if first_name != blank %} {{Random | Hey {{first_name}}, | Hi {{first_name}},}} {% else %} {{Random | Hey, | Hi,}} {% endif %} {{opening_line}}

Your body copy here…

{{sender_signature}}

═══════════════════════════════════════════
VARIANT 2 — Value-prop
═══════════════════════════════════════════

…`;

function isAbort(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

function errMessage(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
