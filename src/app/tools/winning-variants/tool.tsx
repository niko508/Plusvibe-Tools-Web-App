"use client";

// Clone Campaign with Winning Variants.
//
// Pick a workspace and one campaign or several; their first-step variants are shown with
// their all-time sends, replies and positive replies, the top three, and which
// would be kept. A positive reply counts for the first email the lead was sent,
// even when it came after a follow-up — deleted leads included. The campaigns picked fall into segments by name — "🔵 Manufacturing -
// Custom V2 - Signature (September)" and "🟡 Manufacturing - Custom (October)" are one
// segment — and each segment becomes its own clone: the winners of all its campaigns
// in one step 1 (the same email twice counted once), the settings of the one cloned.
// Every clone is named "🟡 <segment>" — no month — and carries google-pool unless
// changed. A clone is made in the same workspace — settings, sender accounts,
// follow-ups and sub-sequences as they are — with step 1 cut down to the variants
// that got at least one positive reply. A segment with none says so plainly and is
// left out unless ticked; its step 1 would be one empty variant to write by hand.
// A box says whether the kept variants carry the opt-out line: ticked adds it
// where it is missing, unticked takes it out.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CampaignSummary, Workspace } from "@/lib/plusvibe-types";
import {
  ApiClientError,
  cloneWinningVariants,
  fetchCampaigns,
  fetchWorkspaces,
  previewWinningVariants,
  type CloneResult,
  type WinnersPreview,
} from "@/lib/api-client";
import {
  cleanTagName,
  defaultCloneTags,
  defaultOptOut,
  groupBySegment,
  planProblems,
  segmentCloneName,
  WINNER_MARK,
  type TagRef,
  type VariantRow,
} from "@/lib/winning-variants/plan";
import { useApiKey } from "@/lib/use-api-key";
import { formatNumber } from "@/lib/format";
import { ConnectPrompt } from "@/components/connect-prompt";
import { EmptyState, Spinner } from "@/components/ui";
import { AlertIcon, CheckIcon, ChevronDownIcon, CopyIcon, RefreshIcon, SparklesIcon, TagIcon } from "@/components/icons";

/** One segment of the pick, and the clone it becomes. */
interface Seg {
  segment: string;
  ids: string[];
  baseId: string;
  preview: WinnersPreview | null;
  error?: string;
  name: string;
  /** Made when the button is pressed. A segment without winners starts left out. */
  include: boolean;
  result?: CloneResult;
  runError?: string;
}

export function WinningVariantsTool() {
  const { hasKey, ready } = useApiKey();

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(false);
  const [ws, setWs] = useState("");
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  /** The campaigns ticked. */
  const [picked, setPicked] = useState<string[]>([]);
  const [campaignFilter, setCampaignFilter] = useState("");
  /** A segment's cloned campaign, when chosen by hand rather than the default. */
  const [baseOverride, setBaseOverride] = useState<Record<string, string>>({});
  /** Bumped by Refresh: the same client's campaigns read again, for another run. */
  const [reloads, setReloads] = useState(0);

  // The pick, grouped into segments in the list's own order (newest first).
  const groups = useMemo(
    () => groupBySegment(campaigns.filter((c) => picked.includes(c.id)).map((c) => ({ id: c.id, name: c.name, createdAt: c.createdAt }))),
    [campaigns, picked]
  );

  const [segs, setSegs] = useState<Seg[]>([]);
  const [loading, setLoading] = useState<{ at: number; of: number } | null>(null);

  const [tagIds, setTagIds] = useState<string[]>([]);
  const [newTags, setNewTags] = useState<string[]>([]);
  const [newTag, setNewTag] = useState("");
  const [optOut, setOptOut] = useState(false);

  const [armed, setArmed] = useState(false);
  const [running, setRunning] = useState<{ at: number; of: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadWorkspaces = useCallback(async () => {
    setWorkspacesLoading(true);
    setError(null);
    try {
      setWorkspaces((await fetchWorkspaces()).workspaces ?? []);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setWorkspacesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (ready && hasKey) void loadWorkspaces();
  }, [ready, hasKey, loadWorkspaces]);

  useEffect(() => {
    setCampaigns([]);
    setPicked([]);
    setBaseOverride({});
    if (!ws) return;
    let cancelled = false;
    setCampaignsLoading(true);
    fetchCampaigns({ workspace_id: ws, campaign_type: "parent" })
      .then((res) => !cancelled && setCampaigns(res.campaigns ?? []))
      .catch((err) => !cancelled && setError(errMessage(err)))
      .finally(() => !cancelled && setCampaignsLoading(false));
    return () => {
      cancelled = true;
    };
  }, [ws, reloads]);

  const baseFor = (g: { segment: string; ids: string[]; baseId: string }) => {
    const o = baseOverride[g.segment];
    return o && g.ids.includes(o) ? o : g.baseId;
  };

  // The figures are read only when asked for, so every campaign can be ticked
  // first. Changing the pick clears what was read: it no longer matches.
  const pickKey = `${ws}|${groups.map((g) => `${g.segment}:${baseFor(g)}:${g.ids.join(",")}`).join("|")}`;
  const [loadKey, setLoadKey] = useState<string | null>(null);
  useEffect(() => {
    setSegs([]);
    setArmed(false);
    setLoadKey(null);
    setLoading(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickKey]);

  useEffect(() => {
    if (!loadKey || loadKey !== pickKey || !ws || groups.length === 0) return;
    let cancelled = false;
    setError(null);
    (async () => {
      const out: Seg[] = [];
      for (let i = 0; i < groups.length; i++) {
        if (cancelled) return;
        setLoading({ at: i + 1, of: groups.length });
        const g = groups[i];
        const baseId = baseFor(g);
        const alsoIds = g.ids.filter((id) => id !== baseId);
        try {
          const p = await previewWinningVariants({ workspaceId: ws, campaignId: baseId, ...(alsoIds.length > 0 ? { alsoIds } : {}) });
          out.push({ segment: g.segment, ids: g.ids, baseId, preview: p, name: segmentCloneName(g.segment), include: !p.plan.noWinners });
        } catch (err) {
          out.push({ segment: g.segment, ids: g.ids, baseId, preview: null, error: errMessage(err), name: segmentCloneName(g.segment), include: false });
        }
      }
      if (cancelled) return;
      setSegs(out);
      const first = out.find((x) => x.preview)?.preview;
      const tags = defaultCloneTags(first?.workspaceTags ?? []);
      setTagIds(tags.tagIds);
      setNewTags(tags.newTags);
      setOptOut(defaultOptOut(out.flatMap((x) => x.preview?.plan.rows ?? [])));
      setLoading(null);
    })();
    return () => {
      cancelled = true;
      setLoading(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey]);

  const workspaceTags = segs.find((x) => x.preview)?.preview?.workspaceTags ?? [];
  const tagById = new Map(workspaceTags.map((t) => [t.id, t]));
  const chosen: TagRef[] = tagIds.map((id) => tagById.get(id) ?? { id, name: id });
  const addable = workspaceTags.filter((t) => !tagIds.includes(t.id));
  const toMake = segs.filter((x) => x.include && x.preview && !x.result);
  const problemsOf = (x: Seg) =>
    x.preview ? planProblems({ workspaceId: ws, campaignId: x.baseId, name: x.name }, { steps: x.preview.plan.rows.length + x.preview.plan.followUps.length }) : [];
  const blocked = toMake.filter((x) => problemsOf(x).length > 0);
  const canRun = toMake.length > 0 && blocked.length === 0 && !running;
  const update = (segment: string, patch: Partial<Seg>) => setSegs((list) => list.map((x) => (x.segment === segment ? { ...x, ...patch } : x)));

  function addNewTag() {
    const n = cleanTagName(newTag);
    if (!n) return;
    const existing = workspaceTags.find((t) => t.name.toLowerCase() === n.toLowerCase());
    if (existing) {
      if (!tagIds.includes(existing.id)) setTagIds((ids) => [...ids, existing.id]);
    } else if (!newTags.some((t) => t.toLowerCase() === n.toLowerCase())) {
      setNewTags((t) => [...t, n]);
    }
    setNewTag("");
  }

  async function run() {
    if (!canRun) return;
    // A segment without winners was ticked on purpose: asked once more here.
    const empty = toMake.filter((x) => x.preview!.plan.noWinners);
    if (
      empty.length > 0 &&
      !window.confirm(
        `${empty.map((x) => x.segment).join(", ")}: no variant in step 1 has a positive reply.\n\nThose clones' step 1 will be ONE EMPTY variant for you to write in Plusvibe. The follow-ups stay as they are.\n\nCreate them anyway?`
      )
    ) {
      setArmed(false);
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    // One after another: each clone duplicates a campaign and rewrites it, and
    // the first one creates google-pool if the workspace has no such tag yet.
    let made: string[] = [];
    const ids = [...tagIds];
    for (let i = 0; i < toMake.length; i++) {
      const x = toMake[i];
      setRunning({ at: i + 1, of: toMake.length });
      const alsoIds = x.ids.filter((id) => id !== x.baseId);
      try {
        const res = await cloneWinningVariants(
          {
            workspaceId: ws,
            campaignId: x.baseId,
            ...(alsoIds.length > 0 ? { alsoIds } : {}),
            name: x.name.trim(),
            tagIds: ids,
            newTags: newTags.filter((n) => !made.includes(n.toLowerCase())),
            confirmEmpty: x.preview!.plan.noWinners,
            optOut,
          },
          controller.signal
        );
        made = [...made, ...res.createdTags.map((n) => n.toLowerCase())];
        // A tag the first clone created is the workspace's now: the rest take it by id.
        if (res.createdTags.length > 0) {
          const created = res.tags.filter((t) => res.createdTags.some((n) => n.toLowerCase() === t.name.toLowerCase())).map((t) => t.id);
          for (const id of created) if (!ids.includes(id)) ids.push(id);
          setTagIds([...ids]);
          setNewTags((cur) => cur.filter((n) => !made.includes(n.toLowerCase())));
        }
        update(x.segment, { result: res, runError: undefined });
      } catch (err) {
        if (controller.signal.aborted) break;
        update(x.segment, { runError: errMessage(err) });
      }
    }
    setArmed(false);
    setRunning(null);
  }

  if (!ready) return <div className="pv-card h-40 animate-pulse" />;
  if (!hasKey) return <ConnectPrompt onConnected={loadWorkspaces} />;

  const loaded = segs.length > 0;
  const keptTotal = toMake.reduce((n, x) => n + (x.preview!.plan.noWinners ? 0 : x.preview!.plan.kept), 0);

  return (
    <div className="space-y-5">
      {/* Pick */}
      <div className="pv-card p-4 sm:p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            label="Workspace"
            value={ws}
            onChange={setWs}
            loading={workspacesLoading}
            options={workspaces.map((w) => ({ value: w._id, label: w.name }))}
            placeholder="Pick a workspace"
          />
          <div />
        </div>
        <CampaignPicker
          campaigns={campaigns}
          loading={campaignsLoading}
          disabled={!ws}
          picked={picked}
          filter={campaignFilter}
          onFilter={setCampaignFilter}
          onToggle={(id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))}
          onPickAll={(ids, on) => setPicked((p) => (on ? [...new Set([...p, ...ids])] : p.filter((x) => !ids.includes(x))))}
          onRefresh={() => {
            // Another run in the same client: the list read again (with any
            // clones just made), the picks, figures and results cleared.
            setSegs([]);
            setError(null);
            setReloads((n) => n + 1);
          }}
          refreshDisabled={!!running || !!loading}
        />
        {groups.length > 0 && (
          <p className="mt-2 text-xs text-muted-foreground" data-segments-found>
            {groups.length === 1
              ? `One segment: ${groups[0].segment} — one clone.`
              : `${groups.length} segments, one clone each: ${groups.map((g) => `${g.segment} (${g.ids.length})`).join(", ")}.`}
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="pv-btn-primary disabled:opacity-50"
            disabled={groups.length === 0 || !!loading || (loadKey === pickKey && loaded)}
            onClick={() => setLoadKey(pickKey)}
            data-find-winners
          >
            {loading ? <Spinner /> : null}
            {loading
              ? `Reading segment ${loading.at} of ${loading.of} — campaigns and their variant stats…`
              : `Find the winners${picked.length > 0 ? ` in ${picked.length} campaign${picked.length === 1 ? "" : "s"}` : ""}`}
          </button>
          {picked.length === 0 && ws && <span className="text-xs text-muted-foreground">Tick the campaigns, then find the winners.</span>}
        </div>
      </div>

      {segs.map((x) => (
        <SegmentSection
          key={x.segment}
          seg={x}
          multi={segs.length > 1}
          campaigns={campaigns}
          problems={problemsOf(x)}
          disabled={!!running}
          onName={(name) => update(x.segment, { name })}
          onInclude={(include) => update(x.segment, { include })}
          onBase={(id) => setBaseOverride((o) => ({ ...o, [x.segment]: id }))}
        />
      ))}

      {loaded && (
        <div className="pv-card space-y-4 p-4 sm:p-5" data-clone-settings>
          <div data-tags>
            <p className="text-xs font-medium text-muted-foreground">Tags{segs.length > 1 ? " — on every clone" : ""}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {chosen.map((t) => (
                <TagChip key={t.id} name={t.name} color={t.color} onRemove={() => setTagIds((ids) => ids.filter((x) => x !== t.id))} />
              ))}
              {newTags.map((n) => (
                <TagChip key={`new:${n}`} name={n} isNew onRemove={() => setNewTags((t) => t.filter((x) => x !== n))} />
              ))}
              {chosen.length + newTags.length === 0 && <span className="text-xs text-muted-foreground">The clones will have no tags.</span>}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {addable.length > 0 && (
                <select
                  className="pv-input w-auto py-1.5 text-xs"
                  value=""
                  aria-label="Add a tag"
                  data-add-tag
                  onChange={(e) => e.target.value && setTagIds((ids) => [...ids, e.target.value])}
                >
                  <option value="">Add a tag…</option>
                  {addable.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              )}
              <input
                className="pv-input w-48 py-1.5 text-xs"
                placeholder="or a new tag"
                value={newTag}
                aria-label="New tag name"
                data-new-tag
                onChange={(e) => setNewTag(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addNewTag();
                }}
              />
              <button type="button" className="pv-btn-ghost py-1.5 text-xs disabled:opacity-50" data-add-new-tag disabled={!cleanTagName(newTag)} onClick={addNewTag}>
                Add
              </button>
            </div>
          </div>

          <OptOutChoiceBox rows={toMake.flatMap((x) => x.preview!.plan.rows)} multi={toMake.length > 1} checked={optOut} onChange={setOptOut} />

          <div className="flex flex-wrap items-center gap-2">
            {armed && (
              <button type="button" className="pv-btn-ghost" onClick={() => setArmed(false)}>
                Cancel
              </button>
            )}
            <button
              type="button"
              data-run
              className={`pv-btn ${armed ? "bg-danger text-white shadow-soft hover:brightness-110" : "pv-btn-primary"} disabled:opacity-50`}
              disabled={!canRun}
              onClick={() => (armed ? void run() : setArmed(true))}
            >
              {running ? <Spinner /> : <CopyIcon size={16} />}
              {running
                ? `Cloning ${running.at} of ${running.of}…`
                : armed
                  ? `Really create ${toMake.length === 1 ? "it" : `all ${toMake.length}`}? Click again`
                  : toMake.length > 1
                    ? `Clone ${toMake.length} campaigns with winning variants`
                    : "Clone with winning variants"}
            </button>
            <span className="text-xs text-muted-foreground">
              {toMake.length === 0
                ? segs.some((x) => x.result)
                  ? "Every clone ticked has been made."
                  : "Tick a segment to clone."
                : `${toMake.length} clone${toMake.length === 1 ? "" : "s"} · ${formatNumber(keptTotal)} step-1 variant${keptTotal === 1 ? "" : "s"} kept in all.`}{" "}
              Clones are drafts; nothing is launched.
            </span>
          </div>
          {blocked.length > 0 && (
            <ul className="space-y-1">
              {blocked.flatMap((x) => problemsOf(x).map((p) => `${x.segment}: ${p}`)).map((p) => (
                <li key={p} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <AlertIcon size={12} /> {p}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger" data-error>
          <AlertIcon size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {segs.filter((x) => x.result || x.runError).map((x) =>
        x.result ? (
          <ResultCard key={`r:${x.segment}`} result={x.result} />
        ) : (
          <div key={`e:${x.segment}`} className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger" data-run-error={x.segment}>
            <AlertIcon size={16} className="mt-0.5 shrink-0" />
            <span>
              {x.segment}: {x.runError}
            </span>
          </div>
        )
      )}

      {!loaded && !loading && (
        <EmptyState icon={<SparklesIcon />} title="Pick campaigns">
          Tick every campaign of a client: they are split into segments by name, and each segment&apos;s first-step variants are
          shown with their sends, replies and positive replies before anything is created.
        </EmptyState>
      )}
    </div>
  );
}

/** One segment: its winners, the campaign cloned, and the clone's name. */
function SegmentSection({
  seg,
  multi,
  campaigns,
  problems,
  disabled,
  onName,
  onInclude,
  onBase,
}: {
  seg: Seg;
  multi: boolean;
  campaigns: CampaignSummary[];
  problems: string[];
  disabled: boolean;
  onName: (v: string) => void;
  onInclude: (v: boolean) => void;
  onBase: (id: string) => void;
}) {
  const preview = seg.preview;
  const plan = preview?.plan ?? null;
  const [open, setOpen] = useState(!multi);
  const nameOf = (id: string) => campaigns.find((c) => c.id === id)?.name ?? id;
  return (
    <div className={`pv-card p-0 ${seg.include || !multi ? "" : "opacity-70"}`} data-segment={seg.segment}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4 sm:px-5">
        <label className="flex items-center gap-2.5">
          {multi && (
            <input
              type="checkbox"
              checked={seg.include}
              disabled={disabled || !preview || !!seg.result}
              onChange={(e) => onInclude(e.target.checked)}
              aria-label={`Clone ${seg.segment}`}
              data-segment-include
            />
          )}
          <span className="text-sm font-semibold">{seg.segment}</span>
          <span className="text-xs text-muted-foreground">
            {seg.ids.length} campaign{seg.ids.length === 1 ? "" : "s"}
          </span>
        </label>
        {plan && (
          <span className="text-xs text-muted-foreground" data-segment-summary>
            {plan.noWinners ? "No winners" : `${formatNumber(plan.kept)} of ${formatNumber(plan.rows.length)} step-1 variants kept`}
            {plan.top3[0] ? ` · best: ${formatNumber(plan.top3[0].positiveReplies)} positive` : ""}
          </span>
        )}
      </div>

      {seg.error && (
        <p className="mx-4 mt-3 flex items-start gap-2 text-sm text-danger sm:mx-5">
          <AlertIcon size={16} className="mt-0.5 shrink-0" /> Could not read this segment: {seg.error}
        </p>
      )}

      {plan && preview && (
        <div className="space-y-3 px-4 pb-4 pt-3 sm:px-5">
          {plan.noWinners && (
            <div className="flex items-start gap-3 rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger" data-no-winners role="alert">
              <AlertIcon size={18} className="mt-0.5 shrink-0" />
              <p>
                No variant in step {plan.firstStep} has a positive reply. {multi ? "Left out unless ticked; if made, its" : "The clone's"} step{" "}
                {plan.firstStep} would be <strong>one empty variant</strong> to write in Plusvibe.
              </p>
            </div>
          )}

          {preview.followUps && (preview.followUps.credited > 0 || preview.followUps.untraced > 0) && (
            <p className="text-xs text-muted-foreground" data-follow-up-credit>
              {preview.followUps.credited > 0
                ? `Includes ${formatNumber(preview.followUps.credited)} positive repl${preview.followUps.credited === 1 ? "y" : "ies"} to follow-ups, counted for the first email that lead was sent.`
                : ""}
              {preview.followUps.untraced > 0
                ? ` ${formatNumber(preview.followUps.untraced)} positive repl${preview.followUps.untraced === 1 ? "y" : "ies"} to follow-ups couldn't be traced to a first email and ${preview.followUps.untraced === 1 ? "isn't" : "aren't"} counted.`
                : ""}
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">New campaign name</label>
              <input className="pv-input" value={seg.name} disabled={disabled || !!seg.result} data-name onChange={(e) => onName(e.target.value)} />
            </div>
            {seg.ids.length > 1 ? (
              <Select
                label="Settings, follow-ups and sub-sequences from"
                value={seg.baseId}
                onChange={onBase}
                disabled={disabled || !!seg.result}
                options={seg.ids.map((id) => ({ value: id, label: nameOf(id) }))}
                placeholder="Pick one"
              />
            ) : (
              <div className="text-xs text-muted-foreground sm:pt-6">Settings, follow-ups and sub-sequences from {preview.campaignName}.</div>
            )}
          </div>
          {problems.length > 0 && seg.include && (
            <ul className="space-y-1">
              {problems.map((p) => (
                <li key={p} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <AlertIcon size={12} /> {p}
                </li>
              ))}
            </ul>
          )}

          {!plan.noWinners && (
            <div className="grid gap-3 sm:grid-cols-3" data-top3>
              {plan.top3.map((r, i) => (
                <div key={`${r.campaignId ?? ""}:${r.variation}`} className="rounded-xl border border-border p-3" data-top-variant={r.variation}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs text-muted-foreground">
                      #{i + 1} · Variant {r.variation}
                      {r.campaignName ? ` · from ${r.campaignName}` : ""}
                    </span>
                    <span className="text-xs tabular-nums text-muted-foreground">{r.positiveRate}%</span>
                  </div>
                  <div className="mt-1 text-2xl font-semibold tabular-nums text-success">{formatNumber(r.positiveReplies)}</div>
                  <div className="text-xs text-muted-foreground">
                    positive repl{r.positiveReplies === 1 ? "y" : "ies"} · {formatNumber(r.sent)} sent
                  </div>
                  {r.subject && <div className="mt-1 truncate text-xs" title={r.subject}>{r.subject}</div>}
                </div>
              ))}
            </div>
          )}

          <button type="button" className="text-xs text-muted-foreground underline" onClick={() => setOpen((o) => !o)} data-toggle-variants>
            {open ? "Hide" : "Show"} all {formatNumber(plan.rows.length)} step-{plan.firstStep} variants
          </button>
          {open && <VariantTable plan={plan} preview={preview} />}
          {!plan.noWinners && (
            <p className="text-xs text-muted-foreground" data-winner-mark>
              {plan.marked.length > 0
                ? `${plan.marked.length === 1 ? "Variant" : "Variants"} ${plan.marked.join(", ")} — the most positive replies (${formatNumber(plan.top3[0]?.positiveReplies ?? 0)}) — get “${WINNER_MARK}” after ${plan.marked.length === 1 ? "its" : "their"} name.`
                : `No variant gets “${WINNER_MARK}”: none has more than one positive reply.`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function VariantTable({ plan, preview }: { plan: WinnersPreview["plan"]; preview: WinnersPreview }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border" data-variants>
      <div className="px-3 pt-3 text-xs text-muted-foreground">
        {plan.noWinners ? "None kept" : `${formatNumber(plan.kept)} kept · ${formatNumber(plan.dropped)} left out`}
        {plan.droppedDeleted > 0 ? ` · ${formatNumber(plan.droppedDeleted)} deleted in Plusvibe, left out` : ""}
        {plan.merged ? ` · ${formatNumber(plan.merged)} the same email as another, counted together` : ""}
        {plan.overLimit ? ` · ${formatNumber(plan.overLimit)} over the per-step limit, left out` : ""}
      </div>
      <table className="mt-2 w-full text-xs">
        <thead>
          <tr className="text-left text-muted-foreground">
            {plan.campaigns && <th className="px-3 py-2 font-medium">Campaign</th>}
            <th className="px-3 py-2 font-medium">Variant</th>
            <th className="px-3 py-2 font-medium">Subject</th>
            <th className="px-3 py-2 text-right font-medium">Sent</th>
            <th className="px-3 py-2 text-right font-medium">Replies</th>
            <th className="px-3 py-2 text-right font-medium">Positive</th>
            <th className="px-3 py-2 text-right font-medium">Positive %</th>
            <th className="px-3 py-2 font-medium">Opt-out</th>
            <th className="px-3 py-2 font-medium">In the clone</th>
          </tr>
        </thead>
        <tbody>
          {plan.rows.map((r) => (
            <tr key={`${r.campaignId ?? ""}:${r.variation}`} className="border-t border-border" data-variant-row={r.variation} data-variant-campaign={r.campaignId}>
              {plan.campaigns && <td className="max-w-[220px] truncate px-3 py-2" title={r.campaignName}>{r.campaignName}</td>}
              <td className="px-3 py-2 font-mono">{r.variation}</td>
              <td className="max-w-[320px] truncate px-3 py-2" title={r.subject}>
                {r.subject || <span className="text-muted-foreground">—</span>}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{formatNumber(r.sent)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatNumber(r.replies)}</td>
              <td className={`px-3 py-2 text-right tabular-nums ${r.positiveReplies > 0 ? "font-semibold text-success" : ""}`}>{formatNumber(r.positiveReplies)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{r.positiveRate}%</td>
              <td className="px-3 py-2" data-opt-out={r.optOut}>
                {r.optOut === "current" ? "Yes" : r.optOut === "older" ? "Older wording" : <span className="text-muted-foreground">—</span>}
              </td>
              <td className="px-3 py-2" data-kept={String(r.kept)}>
                {r.kept && r.sameAs ? (
                  <span className="text-muted-foreground" title={`The same email as ${r.sameAs}`}>
                    Same as {r.newLetter} — counted in
                  </span>
                ) : r.kept ? (
                  <span className="inline-flex items-center gap-1 text-success">
                    <CheckIcon size={12} /> Kept{r.newLetter && (plan.campaigns || r.newLetter !== r.variation) ? ` as ${r.newLetter}` : ""}
                    {plan.marked.includes(r.newLetter ?? r.variation) ? " · Previous Winner" : ""}
                  </span>
                ) : (
                  <span className="text-muted-foreground">Left out</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-border px-3 py-3 text-xs text-muted-foreground" data-follow-ups>
        {plan.campaigns ? `Settings, sender accounts and follow-ups are ${preview.campaignName}'s. ` : ""}
        {plan.followUps.length === 0
          ? "No follow-up steps."
          : `Follow-ups kept as they are: ${plan.followUps.map((f) => `step ${f.step} (${f.variations} variant${f.variations === 1 ? "" : "s"})`).join(", ")}.`}
        {preview.subsequences > 0 ? ` ${formatNumber(preview.subsequences)} sub-sequence${preview.subsequences === 1 ? " comes" : "s come"} along too.` : ""}
      </p>
    </div>
  );
}

function ResultCard({ result }: { result: CloneResult }) {
  return (
    <div className="pv-card p-4 sm:p-5" data-result>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${result.verified ? "bg-success/10 text-success" : "bg-warning/10 text-warning"}`}>
          {result.verified ? "Cloned" : "Cloned with problems"}
        </span>
        <span className="text-sm font-medium">{result.name}</span>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label={`Step ${result.plan.firstStep} variants kept`} value={result.plan.noWinners ? 0 : result.plan.kept} />
        <Metric label="Left out" value={result.plan.dropped} />
        <Metric label="Follow-up steps" value={result.plan.followUps.length} />
        <Metric label="Sub-sequences" value={result.subsequences} />
      </div>
      {result.plan.optOut.choice !== "keep" && !result.plan.noWinners && (
        <p className="mt-3 text-xs text-muted-foreground" data-result-opt-out>
          Opt-out line: {optOutReport(result.plan.optOut)}
        </p>
      )}
      <p className="mt-3 text-xs text-muted-foreground" data-result-tags>
        Tags: {result.tags.length > 0 ? result.tags.map((t) => t.name).join(", ") : "none"}
        {result.createdTags.length > 0 ? ` (new: ${result.createdTags.join(", ")})` : ""}.
      </p>
      {result.verified && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-success">
          <CheckIcon size={13} /> Read back from Plusvibe and it matches.
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
      <p className="mt-3 text-xs text-muted-foreground">The clone is a draft beside the originals. Check it in Plusvibe, then launch it there.</p>
    </div>
  );
}

const letters = (l: string[]) => l.join(", ");

function OptOutChoiceBox({ rows, multi, checked, onChange }: { rows: VariantRow[]; multi?: boolean; checked: boolean; onChange: (v: boolean) => void }) {
  // The variants that go into the clone, under their letters there: one per
  // email when several campaigns were picked.
  const kept = rows.filter((r) => r.kept && !r.sameAs);
  const letter = (r: VariantRow) => r.newLetter ?? r.variation;
  const none = kept.filter((r) => r.optOut === "none").map(letter);
  const older = kept.filter((r) => r.optOut === "older").map(letter);
  const current = kept.filter((r) => r.optOut === "current").map(letter);
  const having = kept.filter((r) => r.optOut !== "none").map(letter);
  let note: string;
  const n = (l: string[]) => `${l.length} variant${l.length === 1 ? "" : "s"}`;
  if (multi) {
    note = checked
      ? [none.length ? `added to ${n(none)}` : null, older.length ? `older wording swapped on ${n(older)}` : null, current.length ? `${n(current)} already have it` : null].filter(Boolean).join("; ") + "."
      : having.length > 0
        ? `Taken out of ${n(having)}.`
        : "None of the kept variants has it, so nothing changes.";
  } else if (checked) {
    const bits = [
      none.length > 0 ? `added to ${letters(none)}` : null,
      older.length > 0 ? `the older wording on ${letters(older)} swapped for the current one` : null,
      current.length > 0 ? `${letters(current)} already ${current.length === 1 ? "has" : "have"} it` : null,
    ].filter(Boolean);
    note = bits.length > 0 ? `${bits.join("; ")}.` : "";
  } else {
    note = having.length > 0 ? `Taken out of ${letters(having)}.` : "None of the kept variants has it, so nothing changes.";
  }
  return (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-border p-3" data-opt-out-choice>
      <input type="checkbox" className="mt-0.5 h-4 w-4 accent-accent" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label="Opt-out text on the kept variants" />
      <span className="text-sm">
        <span className="font-medium">Opt-out text on the kept variants{multi ? " — every clone" : ""}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground" data-opt-out-note>
          {checked ? "Every kept step-1 variant ends with the opt-out line: " : "No kept step-1 variant carries the opt-out line. "}
          {note} Follow-ups are left as they are.
        </span>
      </span>
    </label>
  );
}

function optOutReport(o: { choice: string; added: string[]; replaced: string[]; present: string[]; removed: string[] }): string {
  if (o.choice === "remove") return o.removed.length > 0 ? `taken out of ${letters(o.removed)}.` : "none of the kept variants had it.";
  const bits = [
    o.added.length > 0 ? `added to ${letters(o.added)}` : null,
    o.replaced.length > 0 ? `older wording swapped on ${letters(o.replaced)}` : null,
    o.present.length > 0 ? `already on ${letters(o.present)}` : null,
  ].filter(Boolean);
  return `${bits.join("; ")}.`;
}

function TagChip({ name, color, isNew, onRemove }: { name: string; color?: string; isNew?: boolean; onRemove: () => void }) {
  return (
    <span className="pv-chip inline-flex items-center gap-1.5" data-tag-chip={name}>
      <span style={color ? { color } : undefined} className="inline-flex">
        <TagIcon size={12} />
      </span>
      {name}
      {isNew && <span className="text-[10px] text-muted-foreground">new</span>}
      <button type="button" className="text-muted-foreground hover:text-danger" aria-label={`Remove the tag ${name}`} onClick={onRemove}>
        ×
      </button>
    </span>
  );
}

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
      <label className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</label>
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
        <ChevronDownIcon size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
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

/** The campaigns to take winners from: tick one, or several. */
function CampaignPicker({
  campaigns,
  loading,
  disabled,
  picked,
  filter,
  onFilter,
  onToggle,
  onPickAll,
  onRefresh,
  refreshDisabled,
}: {
  campaigns: CampaignSummary[];
  loading: boolean;
  disabled: boolean;
  picked: string[];
  filter: string;
  onFilter: (v: string) => void;
  onToggle: (id: string) => void;
  onPickAll: (ids: string[], on: boolean) => void;
  onRefresh: () => void;
  refreshDisabled?: boolean;
}) {
  const q = filter.trim().toLowerCase();
  const shown = campaigns.filter((c) => !q || c.name.toLowerCase().includes(q));
  return (
    <div className="mt-3" data-campaign-picker>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          Campaigns to take the winners from{picked.length > 0 ? ` · ${picked.length} picked` : ""}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          {campaigns.length > 8 && (
            <input className="pv-input w-48 py-1 text-xs" placeholder="Filter campaigns…" value={filter} aria-label="Filter campaigns" onChange={(e) => onFilter(e.target.value)} />
          )}
          {!disabled && (
            <button
              type="button"
              className="pv-btn-ghost py-1 text-xs disabled:opacity-50"
              data-refresh
              disabled={loading || refreshDisabled}
              title="Read this workspace's campaigns again and start a new run"
              onClick={onRefresh}
            >
              <RefreshIcon size={12} /> Refresh
            </button>
          )}
          {shown.length > 0 && !disabled && (
            <button
              type="button"
              className="pv-btn-ghost py-1 text-xs"
              data-pick-all
              onClick={() => onPickAll(shown.map((c) => c.id), !shown.every((c) => picked.includes(c.id)))}
            >
              {shown.every((c) => picked.includes(c.id)) ? "Clear" : q ? "Pick shown" : "Pick all"}
            </button>
          )}
        </div>
      </div>
      {disabled ? (
        <p className="text-xs text-muted-foreground">Pick a workspace first.</p>
      ) : loading ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner size={12} /> Loading campaigns…
        </p>
      ) : (
        <div className="pv-scroll max-h-64 overflow-y-auto rounded-xl border border-border p-1.5">
          {shown.map((c) => (
            <label key={c.id} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-muted/40" data-campaign-option={c.id}>
              <input type="checkbox" checked={picked.includes(c.id)} onChange={() => onToggle(c.id)} aria-label={`Pick ${c.name}`} />
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
            </label>
          ))}
          {shown.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">{campaigns.length === 0 ? "No campaigns in this workspace." : "No campaign matches."}</p>}
        </div>
      )}
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        Campaigns are split into segments by name — colour, V2, Signature, Opt Out and month aside — and each segment becomes one
        🟡 clone. Within a segment, every step-1 variant with a positive reply in any of its campaigns goes into one step 1,
        strongest first; the same email in two of them (a 🟡 campaign and its 🔵 copy) is counted once.
      </p>
    </div>
  );
}
