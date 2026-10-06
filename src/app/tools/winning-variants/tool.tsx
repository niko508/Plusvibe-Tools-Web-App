"use client";

// Clone Campaign with Winning Variants.
//
// Pick a workspace and one campaign or several; their first-step variants are shown with
// their all-time sends, replies and positive replies, the top three, and which
// would be kept. With several, the winners of all of them go into one step 1
// (the same email twice counted once), and the clone takes the settings of the
// one picked to clone from. The clone is made in the same workspace — settings, sender
// accounts, follow-ups and sub-sequences as they are — with step 1 cut down to
// the variants that got at least one positive reply. When none did, the page
// says so plainly and step 1 becomes one empty variant to write by hand.
// A box says whether the kept variants carry the opt-out line: ticked adds it
// where it is missing, unticked takes it out.

import { useCallback, useEffect, useRef, useState } from "react";
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
import { cleanTagName, defaultName, defaultOptOut, planProblems, resultName, type TagRef, type VariantRow } from "@/lib/winning-variants/plan";
import { useApiKey } from "@/lib/use-api-key";
import { formatNumber } from "@/lib/format";
import { ConnectPrompt } from "@/components/connect-prompt";
import { EmptyState, Spinner } from "@/components/ui";
import { AlertIcon, CheckIcon, ChevronDownIcon, CopyIcon, SparklesIcon, TagIcon } from "@/components/icons";

export function WinningVariantsTool() {
  const { hasKey, ready } = useApiKey();

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(false);
  const [ws, setWs] = useState("");
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  /** The campaigns ticked, in the order they were ticked. */
  const [picked, setPicked] = useState<string[]>([]);
  /** The one cloned — settings, follow-ups, sub-sequences. The first ticked unless chosen. */
  const [baseId, setBaseId] = useState("");
  const [campaignFilter, setCampaignFilter] = useState("");
  const campaignId = picked.includes(baseId) ? baseId : picked[0] ?? "";
  const alsoIds = picked.filter((id) => id !== campaignId);
  const alsoKey = alsoIds.join(",");

  const [preview, setPreview] = useState<WinnersPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [name, setName] = useState("");
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [newTags, setNewTags] = useState<string[]>([]);
  const [newTag, setNewTag] = useState("");
  const [optOut, setOptOut] = useState(false);
  const [nameResults, setNameResults] = useState(true);

  const [armed, setArmed] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CloneResult | null>(null);
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
    setBaseId("");
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
  }, [ws]);

  // The campaigns' figures and the cloned one's tags. The name and tags start
  // as its own. A moment's pause first, so ticking several reads them once.
  useEffect(() => {
    setPreview(null);
    setResult(null);
    setArmed(false);
    if (!ws || !campaignId) return;
    let cancelled = false;
    setPreviewLoading(true);
    setError(null);
    const t = setTimeout(() => {
    previewWinningVariants({ workspaceId: ws, campaignId, ...(alsoIds.length > 0 ? { alsoIds } : {}) })
      .then((p) => {
        if (cancelled) return;
        setPreview(p);
        setName(defaultName(p.campaignName));
        setTagIds(p.tags.map((t) => t.id));
        setNewTags([]);
        setOptOut(defaultOptOut(p.plan.rows));
      })
      .catch((err) => !cancelled && setError(errMessage(err)))
      .finally(() => !cancelled && setPreviewLoading(false));
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, campaignId, alsoKey]);

  const plan = preview?.plan ?? null;
  const problems = planProblems({ workspaceId: ws, campaignId, name }, { steps: plan ? plan.rows.length + plan.followUps.length : undefined });
  const canRun = !!preview && problems.length === 0 && !running;
  const tagById = new Map((preview?.workspaceTags ?? []).map((t) => [t.id, t]));
  const chosen: TagRef[] = tagIds.map((id) => tagById.get(id) ?? { id, name: id });
  const addable = (preview?.workspaceTags ?? []).filter((t) => !tagIds.includes(t.id));

  function addNewTag() {
    const n = cleanTagName(newTag);
    if (!n) return;
    const existing = (preview?.workspaceTags ?? []).find((t) => t.name.toLowerCase() === n.toLowerCase());
    if (existing) {
      if (!tagIds.includes(existing.id)) setTagIds((ids) => [...ids, existing.id]);
    } else if (!newTags.some((t) => t.toLowerCase() === n.toLowerCase())) {
      setNewTags((t) => [...t, n]);
    }
    setNewTag("");
  }

  async function run() {
    if (!canRun || !plan) return;
    // Nothing won in step 1: said on the page, and asked once more here.
    if (
      plan.noWinners &&
      !window.confirm(
        `No variant in step ${plan.firstStep} has a positive reply.\n\nThe clone's step ${plan.firstStep} will be ONE EMPTY variant for you to write in Plusvibe. The follow-ups stay as they are.\n\nCreate it anyway?`
      )
    ) {
      setArmed(false);
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await cloneWinningVariants(
        { workspaceId: ws, campaignId, ...(alsoIds.length > 0 ? { alsoIds } : {}), name: name.trim(), tagIds, newTags, confirmEmpty: plan.noWinners, optOut, nameResults },
        controller.signal
      );
      setResult(res);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setArmed(false);
      setRunning(false);
    }
  }

  if (!ready) return <div className="pv-card h-40 animate-pulse" />;
  if (!hasKey) return <ConnectPrompt onConnected={loadWorkspaces} />;

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
          {picked.length > 1 ? (
            <Select
              label="Clone settings, follow-ups and sub-sequences from"
              value={campaignId}
              onChange={setBaseId}
              options={picked.map((id) => ({ value: id, label: campaigns.find((c) => c.id === id)?.name ?? id }))}
              placeholder="Pick one"
            />
          ) : (
            <div />
          )}
        </div>
        <CampaignPicker
          campaigns={campaigns}
          loading={campaignsLoading}
          disabled={!ws}
          picked={picked}
          filter={campaignFilter}
          onFilter={setCampaignFilter}
          onToggle={(id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))}
        />
        {previewLoading && (
          <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner size={12} /> Reading {picked.length > 1 ? `${picked.length} campaigns and their` : "the campaign and its"} variant stats…
          </p>
        )}
      </div>

      {plan && preview && (
        <>
          {plan.noWinners ? (
            <div className="flex items-start gap-3 rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger" data-no-winners role="alert">
              <AlertIcon size={18} className="mt-0.5 shrink-0" />
              <div>
                <p className="font-semibold">No variant in step {plan.firstStep} has a positive reply.</p>
                <p className="mt-1 text-danger/90">
                  The clone&apos;s step {plan.firstStep} will be <strong>one empty variant</strong> for you to write in Plusvibe. Its
                  follow-ups stay as they are.
                </p>
              </div>
            </div>
          ) : (
            <div className="pv-card p-4 sm:p-5" data-top3>
              <h2 className="text-sm font-semibold">Top {plan.top3.length} in step {plan.firstStep}</h2>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                {plan.top3.map((r, i) => (
                  <div key={r.variation} className="rounded-xl border border-border p-3" data-top-variant={r.variation}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-muted-foreground">#{i + 1} · Variant {r.variation}{r.campaignName ? ` · from ${r.campaignName}` : ""}</span>
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
            </div>
          )}

          <div className="pv-card overflow-x-auto p-0" data-variants>
            <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-4 sm:px-5">
              <h2 className="text-sm font-semibold">Step {plan.firstStep} · all time</h2>
              <span className="text-xs text-muted-foreground">
                {plan.noWinners
                  ? "None kept"
                  : `${formatNumber(plan.kept)} kept · ${formatNumber(plan.dropped)} left out`}
                {plan.droppedDeleted > 0 ? ` · ${formatNumber(plan.droppedDeleted)} deleted in Plusvibe, left out` : ""}
                {plan.merged ? ` · ${formatNumber(plan.merged)} the same email as another, counted together` : ""}
                {plan.overLimit ? ` · ${formatNumber(plan.overLimit)} over the per-step limit, left out` : ""}
              </span>
            </div>
            <table className="mt-2 w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground">
                  {plan.campaigns && <th className="px-4 py-2 font-medium sm:px-5">Campaign</th>}
                  <th className={`py-2 font-medium ${plan.campaigns ? "px-3" : "px-4 sm:px-5"}`}>Variant</th>
                  <th className="px-3 py-2 font-medium">Subject</th>
                  <th className="px-3 py-2 text-right font-medium">Sent</th>
                  <th className="px-3 py-2 text-right font-medium">Replies</th>
                  <th className="px-3 py-2 text-right font-medium">Positive</th>
                  <th className="px-3 py-2 text-right font-medium">Positive %</th>
                  <th className="px-3 py-2 font-medium">Opt-out</th>
                  <th className="px-4 py-2 font-medium sm:px-5">In the clone</th>
                </tr>
              </thead>
              <tbody>
                {plan.rows.map((r) => (
                  <tr key={`${r.campaignId ?? ""}:${r.variation}`} className="border-t border-border" data-variant-row={r.variation} data-variant-campaign={r.campaignId}>
                    {plan.campaigns && <td className="max-w-[220px] truncate px-4 py-2 sm:px-5" title={r.campaignName}>{r.campaignName}</td>}
                    <td className={`py-2 font-mono ${plan.campaigns ? "px-3" : "px-4 sm:px-5"}`}>{r.variation}</td>
                    <td className="max-w-[320px] truncate px-3 py-2" title={r.subject}>
                      {r.subject || <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatNumber(r.sent)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatNumber(r.replies)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${r.positiveReplies > 0 ? "font-semibold text-success" : ""}`}>
                      {formatNumber(r.positiveReplies)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.positiveRate}%</td>
                    <td className="px-3 py-2" data-opt-out={r.optOut}>
                      {r.optOut === "current" ? "Yes" : r.optOut === "older" ? "Older wording" : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-4 py-2 sm:px-5" data-kept={String(r.kept)}>
                      {r.kept && r.sameAs ? (
                        <span className="text-muted-foreground" title={`The same email as ${r.sameAs}`}>
                          Same as {r.newLetter} — counted in
                        </span>
                      ) : r.kept ? (
                        <span className="inline-flex items-center gap-1 text-success">
                          <CheckIcon size={12} /> Kept{plan.campaigns && r.newLetter ? ` as ${r.newLetter}` : ""}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">Left out</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground sm:px-5" data-follow-ups>
              {plan.campaigns ? `Settings, sender accounts and follow-ups are ${preview.campaignName}'s. ` : ""}
              {plan.followUps.length === 0
                ? "No follow-up steps."
                : `Follow-ups kept as they are: ${plan.followUps.map((f) => `step ${f.step} (${f.variations} variant${f.variations === 1 ? "" : "s"})`).join(", ")}.`}
              {preview.subsequences > 0 ? ` ${formatNumber(preview.subsequences)} sub-sequence${preview.subsequences === 1 ? " comes" : "s come"} along too.` : ""}
            </p>
          </div>

          {/* Name, tags, run */}
          <div className="pv-card space-y-4 p-4 sm:p-5">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground" htmlFor="wv-name">
                New campaign name
              </label>
              <input
                id="wv-name"
                className="pv-input"
                value={name}
                placeholder={preview.campaignName}
                data-name
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div data-tags>
              <p className="text-xs font-medium text-muted-foreground">Tags</p>
              <p className="mt-0.5 text-xs text-muted-foreground" data-current-tags>
                On &ldquo;{preview.campaignName}&rdquo; now:{" "}
                {preview.tags.length > 0 ? preview.tags.map((t) => t.name).join(", ") : "no tags"}.
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {chosen.map((t) => (
                  <TagChip key={t.id} name={t.name} color={t.color} onRemove={() => setTagIds((ids) => ids.filter((x) => x !== t.id))} />
                ))}
                {newTags.map((n) => (
                  <TagChip key={`new:${n}`} name={n} isNew onRemove={() => setNewTags((t) => t.filter((x) => x !== n))} />
                ))}
                {chosen.length + newTags.length === 0 && <span className="text-xs text-muted-foreground">The clone will have no tags.</span>}
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

            {!plan.noWinners && <OptOutChoiceBox rows={plan.rows} checked={optOut} onChange={setOptOut} />}
            {!plan.noWinners && (
              <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-border p-3" data-name-results>
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-accent"
                  checked={nameResults}
                  onChange={(e) => setNameResults(e.target.checked)}
                  aria-label="Name each kept variant with its results"
                />
                <span className="text-sm">
                  <span className="font-medium">Name each kept variant with its results</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    The variant&apos;s name in Plusvibe starts with its rank and figures, then the name it had —{" "}
                    <span className="font-mono">
                      {resultName(1, plan.top3[0] ?? { positiveReplies: 0, sent: 0 }, "", plan.campaigns && plan.top3[0] ? { campaign: plan.top3[0].campaignName ?? "", letter: rowLetterOf(plan.rows, plan.top3[0]) } : undefined)}
                    </span>
                    {plan.campaigns ? "" : " …"}. Unticked, names stay as they were.
                  </span>
                </span>
              </label>
            )}

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
                {running ? "Cloning…" : armed ? "Really create it? Click again" : "Clone with winning variants"}
              </button>
              <span className="text-xs text-muted-foreground">
                {plan.noWinners
                  ? `Step ${plan.firstStep} will be one empty variant.`
                  : `Step ${plan.firstStep} will keep ${formatNumber(plan.kept)} of ${formatNumber(plan.rows.length)} variants.`}{" "}
                The clone is a draft; nothing is launched.
              </span>
            </div>
            {problems.length > 0 && (
              <ul className="space-y-1">
                {problems.map((p) => (
                  <li key={p} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <AlertIcon size={12} /> {p}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger" data-error>
          <AlertIcon size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {result ? (
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
          <p className="mt-3 text-xs text-muted-foreground">The clone is a draft beside the original. Check it in Plusvibe, then launch it there.</p>
        </div>
      ) : (
        !preview &&
        !previewLoading &&
        !running && (
          <EmptyState icon={<SparklesIcon />} title="Pick a campaign">
            Its first-step variants are shown with their sends, replies and positive replies before anything is created.
          </EmptyState>
        )
      )}
    </div>
  );
}

const letters = (l: string[]) => l.join(", ");

function OptOutChoiceBox({ rows, checked, onChange }: { rows: VariantRow[]; checked: boolean; onChange: (v: boolean) => void }) {
  // The variants that go into the clone, under their letters there: one per
  // email when several campaigns were picked.
  const kept = rows.filter((r) => r.kept && !r.sameAs);
  const letter = (r: VariantRow) => r.newLetter ?? r.variation;
  const none = kept.filter((r) => r.optOut === "none").map(letter);
  const older = kept.filter((r) => r.optOut === "older").map(letter);
  const current = kept.filter((r) => r.optOut === "current").map(letter);
  const having = kept.filter((r) => r.optOut !== "none").map(letter);
  let note: string;
  if (checked) {
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
        <span className="font-medium">Opt-out text on the kept variants</span>
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
}: {
  campaigns: CampaignSummary[];
  loading: boolean;
  disabled: boolean;
  picked: string[];
  filter: string;
  onFilter: (v: string) => void;
  onToggle: (id: string) => void;
}) {
  const q = filter.trim().toLowerCase();
  const shown = campaigns.filter((c) => !q || c.name.toLowerCase().includes(q));
  return (
    <div className="mt-3" data-campaign-picker>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          Campaigns to take the winners from{picked.length > 0 ? ` · ${picked.length} picked` : ""}
        </span>
        {campaigns.length > 8 && (
          <input className="pv-input w-48 py-1 text-xs" placeholder="Filter campaigns…" value={filter} aria-label="Filter campaigns" onChange={(e) => onFilter(e.target.value)} />
        )}
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
              {picked[0] === c.id && picked.length > 1 && <span className="shrink-0 text-[11px] text-muted-foreground">first picked</span>}
            </label>
          ))}
          {shown.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">{campaigns.length === 0 ? "No campaigns in this workspace." : "No campaign matches."}</p>}
        </div>
      )}
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        One campaign keeps its own winners. Several: every step-1 variant with a positive reply in any of them goes into one step 1,
        strongest first — the same email in two of them (a 🟡 campaign and its 🔵 copy) counted once.
      </p>
    </div>
  );
}

/** The letter a top variant had in its own campaign (several campaigns: its row's original letter). */
function rowLetterOf(rows: VariantRow[], top: VariantRow): string {
  return rows.find((r) => r.campaignId === top.campaignId && r.newLetter === top.newLetter && !r.sameAs)?.variation ?? top.variation;
}
