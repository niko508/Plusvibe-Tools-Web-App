"use client";

// Clone Campaign with Winning Variants.
//
// Pick a workspace and a month (read from the "(November)" in the campaign
// names; the latest one to start), then tick the segments. Only the picked
// months' campaigns count. A segment is a campaign name without
// its colour, month, version and Signature / Opt Out suffix: "🔵 Professional
// Services - General (November)" and "🟡 Professional Services - General
// - Signature (October)" are both "Professional Services - General". For each
// segment ticked the server reads every campaign of it, keeps the step-1
// variants that got a positive reply (a positive reply to a follow-up counts for
// the first email the lead got), and duplicates the segment's base campaign —
// its newest plain 🟡 one — as "🟡 <segment>" with only those variants in step 1.
// Settings, sender accounts, follow-ups and sub-sequences stay as they are; the
// clones are drafts. A segment with no winner yet is skipped. The run is a
// background job: the page can be closed, and it goes on after a redeploy.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CampaignSummary, Workspace } from "@/lib/plusvibe-types";
import {
  ApiClientError,
  abortWinningVariantsJob,
  deleteWinningVariantsJob,
  fetchCampaigns,
  fetchTags,
  fetchWorkspaces,
  listWinningVariantsJobs,
  startWinningVariantsJob,
} from "@/lib/api-client";
import { campaignMonth, cleanTagName, groupBySegment, POOL_TAG, segmentCloneName, type TagRef } from "@/lib/winning-variants/plan";
import type { SegmentOutcome, WinningVariantsJob } from "@/lib/jobs/winning-variants-types";
import { MAX_SEGMENTS } from "@/lib/jobs/winning-variants-types";
import { MAX_WINNER_CAMPAIGNS } from "@/lib/winning-variants/limits";
import { useApiKey } from "@/lib/use-api-key";
import { formatNumber } from "@/lib/format";
import { ConnectPrompt } from "@/components/connect-prompt";
import { Spinner } from "@/components/ui";
import { AlertIcon, CheckIcon, ChevronDownIcon, CopyIcon, RefreshIcon, TagIcon } from "@/components/icons";

type OptOut = "keep" | "add" | "remove";

interface SegmentRow {
  segment: string;
  /** The campaigns whose winners count. */
  campaigns: CampaignSummary[];
  baseId: string;
  /** Campaigns of the segment in months not picked. */
  otherMonths: number;
}

export function WinningVariantsTool() {
  const { hasKey, ready } = useApiKey();

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(false);
  const [ws, setWs] = useState("");
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [reloads, setReloads] = useState(0);
  /** The months whose campaigns count, from the "(November)" in their names. */
  const [months, setMonths] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  const [workspaceTags, setWorkspaceTags] = useState<TagRef[]>([]);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [newTags, setNewTags] = useState<string[]>([]);
  const [newTag, setNewTag] = useState("");
  const [optOut, setOptOut] = useState<OptOut>("keep");

  const [armed, setArmed] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<WinningVariantsJob[]>([]);

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

  // The workspace's campaigns and tags.
  useEffect(() => {
    setCampaigns([]);
    setPicked([]);
    setWorkspaceTags([]);
    setArmed(false);
    if (!ws) return;
    let cancelled = false;
    setCampaignsLoading(true);
    Promise.all([fetchCampaigns({ workspace_id: ws, campaign_type: "parent" }), fetchTags({ workspace_id: ws })])
      .then(([c, t]) => {
        if (cancelled) return;
        setCampaigns(c.campaigns ?? []);
        const tags = ((t as { tags?: TagRef[] }).tags ?? []).map((x) => ({ id: x.id, name: x.name, color: x.color }));
        setWorkspaceTags(tags);
        const pool = tags.find((x) => x.name.trim().toLowerCase() === POOL_TAG);
        setTagIds(pool ? [pool.id] : []);
        setNewTags(pool ? [] : [POOL_TAG]);
      })
      .catch((err) => !cancelled && setError(errMessage(err)))
      .finally(() => !cancelled && setCampaignsLoading(false));
    return () => {
      cancelled = true;
    };
  }, [ws, reloads]);

  // Runs: read now, and every few seconds while one is going.
  const loadJobs = useCallback(async () => {
    try {
      setJobs((await listWinningVariantsJobs()).jobs ?? []);
    } catch {
      // the next poll tries again
    }
  }, []);
  useEffect(() => {
    if (ready && hasKey) void loadJobs();
  }, [ready, hasKey, loadJobs]);
  const anyRunning = jobs.some((j) => j.status === "running");
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(loadJobs, 4000);
    return () => clearInterval(t);
  }, [anyRunning, loadJobs]);

  // The months in the campaign names, newest first (by their newest campaign).
  const monthList = useMemo(() => {
    const newest = new Map<string, number>();
    for (const c of campaigns) {
      const m = campaignMonth(c.name, c.createdAt);
      if (m) newest.set(m, Math.max(newest.get(m) ?? 0, c.createdAt ?? 0));
    }
    return [...newest.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
  }, [campaigns]);
  // A workspace starts on its latest month.
  useEffect(() => setMonths(monthList.slice(0, 1)), [monthList]);

  // Segments: the picked months' campaigns grouped by name.
  const segments: SegmentRow[] = useMemo(() => {
    const sorted = [...campaigns].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    const inMonths = (c: CampaignSummary) => {
      const m = campaignMonth(c.name, c.createdAt);
      return !!m && months.includes(m);
    };
    const byId = new Map(sorted.map((c) => [c.id, c]));
    return groupBySegment(sorted.map((c) => ({ id: c.id, name: c.name, createdAt: c.createdAt })))
      .map((g) => {
        const all = g.ids.map((id) => byId.get(id)!).filter(Boolean);
        const used = all.filter(inMonths);
        // The base: the newest plain 🟡 campaign of the months picked.
        const base = groupBySegment(used.map((c) => ({ id: c.id, name: c.name, createdAt: c.createdAt })))[0]?.baseId ?? "";
        return { segment: g.segment, baseId: base, campaigns: used, otherMonths: all.length - used.length };
      })
      .filter((x) => x.campaigns.length > 0)
      .sort((a, b) => a.segment.localeCompare(b.segment));
  }, [campaigns, months]);

  // Ticks on segments the months no longer cover drop away.
  useEffect(() => setPicked((p) => p.filter((x) => segments.some((sg) => sg.segment === x))), [segments]);

  const shown = segments.filter((s) => !filter.trim() || s.segment.toLowerCase().includes(filter.trim().toLowerCase()));
  const chosen = segments.filter((s) => picked.includes(s.segment));
  const tooMany = chosen.length > MAX_SEGMENTS;
  const busy = jobs.some((j) => j.status === "running");
  const canStart = chosen.length > 0 && !tooMany && !busy && !starting;
  const tagById = new Map(workspaceTags.map((t) => [t.id, t]));
  const addable = workspaceTags.filter((t) => !tagIds.includes(t.id));

  useEffect(() => setArmed(false), [picked.length, ws]);

  function toggle(segment: string) {
    setPicked((p) => (p.includes(segment) ? p.filter((x) => x !== segment) : [...p, segment]));
  }

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

  async function start() {
    if (!canStart) return;
    setStarting(true);
    setError(null);
    try {
      const wsName = workspaces.find((w) => w._id === ws)?.name ?? "";
      await startWinningVariantsJob({
        workspaceId: ws,
        workspaceName: wsName,
        segments: chosen.map((s) => {
          // The base, then the newest others: at most this many campaigns' winners in one clone.
          const ids = [s.baseId, ...s.campaigns.map((c) => c.id).filter((id) => id !== s.baseId)].slice(0, MAX_WINNER_CAMPAIGNS);
          return {
            segment: s.segment,
            baseId: s.baseId,
            baseName: s.campaigns.find((c) => c.id === s.baseId)?.name ?? "",
            ids,
            name: segmentCloneName(s.segment),
          };
        }),
        tagIds,
        newTags,
        optOut: optOut === "add" ? true : optOut === "remove" ? false : null,
      });
      setPicked([]);
      setArmed(false);
      await loadJobs();
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setStarting(false);
    }
  }

  if (!ready) return <div className="pv-card h-40 animate-pulse" />;
  if (!hasKey) return <ConnectPrompt onConnected={loadWorkspaces} />;

  return (
    <div className="space-y-5">
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
        </div>

        {ws && (
          <div className="mt-4" data-segments>
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium">
                Segments{segments.length > 0 ? ` · ${segments.length}` : ""}
                {picked.length > 0 ? ` · ${picked.length} ticked` : ""}
              </p>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <input
                  className="pv-input w-48 py-1.5 text-xs"
                  placeholder="Filter segments"
                  value={filter}
                  aria-label="Filter segments"
                  onChange={(e) => setFilter(e.target.value)}
                />
                <button
                  type="button"
                  className="pv-btn-ghost py-1.5 text-xs"
                  data-pick-all
                  disabled={shown.length === 0}
                  onClick={() => {
                    const names = shown.map((s) => s.segment);
                    const all = names.every((n) => picked.includes(n));
                    setPicked((p) => (all ? p.filter((x) => !names.includes(x)) : [...new Set([...p, ...names])]));
                  }}
                >
                  {shown.length > 0 && shown.every((s) => picked.includes(s.segment)) ? "Untick all" : "Tick all"}
                </button>
                <button type="button" className="pv-btn-ghost py-1.5 text-xs" data-refresh disabled={campaignsLoading} onClick={() => setReloads((n) => n + 1)}>
                  <RefreshIcon size={14} /> Refresh
                </button>
              </div>
            </div>
            <div className="mt-3" data-months>
              <p className="text-xs font-medium text-muted-foreground">Month — only campaigns with it in their name count</p>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {monthList.length === 0 && !campaignsLoading && <span className="text-xs text-muted-foreground">No campaign name here carries a month.</span>}
                {monthList.map((m) => (
                  <button
                    key={m}
                    type="button"
                    data-month={m}
                    className={`pv-chip text-xs ${months.includes(m) ? "border-accent bg-accent text-accent-foreground" : ""}`}
                    onClick={() => setMonths((cur) => (cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m]))}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-3 max-h-[28rem] overflow-y-auto rounded-xl border border-border">
              {campaignsLoading ? (
                <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                  <Spinner /> Reading the campaigns…
                </div>
              ) : shown.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">{segments.length === 0 ? (months.length === 0 ? "Pick a month." : "No campaigns in that month.") : "No segment matches."}</p>
              ) : (
                shown.map((s) => {
                  const base = s.campaigns.find((c) => c.id === s.baseId);
                  const isOpen = open === s.segment;
                  return (
                    <div key={s.segment} className="border-b border-border last:border-b-0" data-segment={s.segment}>
                      <div className="flex items-center gap-3 px-3 py-2.5">
                        <input type="checkbox" checked={picked.includes(s.segment)} onChange={() => toggle(s.segment)} aria-label={`Tick ${s.segment}`} />
                        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => toggle(s.segment)}>
                          <span className="block truncate text-sm font-medium">{s.segment}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            Clones {base?.name ?? "—"} as {segmentCloneName(s.segment)}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="pv-chip shrink-0 text-xs"
                          onClick={() => setOpen(isOpen ? null : s.segment)}
                          aria-expanded={isOpen}
                        >
                          {s.campaigns.length} campaign{s.campaigns.length === 1 ? "" : "s"}
                          {s.otherMonths > 0 ? ` · ${s.otherMonths} in other months` : ""}
                          <ChevronDownIcon size={12} className={isOpen ? "rotate-180" : ""} />
                        </button>
                      </div>
                      {isOpen && (
                        <ul className="space-y-0.5 px-10 pb-2.5 text-xs text-muted-foreground">
                          {s.campaigns.map((c, i) => (
                            <li key={c.id} className={i >= MAX_WINNER_CAMPAIGNS ? "line-through" : ""}>
                              {c.name}
                              {c.id === s.baseId ? " · cloned" : ""}
                              {c.status ? ` · ${c.status.toLowerCase()}` : ""}
                            </li>
                          ))}
                          {s.campaigns.length > MAX_WINNER_CAMPAIGNS && <li>Only the newest {MAX_WINNER_CAMPAIGNS} count.</li>}
                        </ul>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>

      {ws && (
        <div className="pv-card space-y-4 p-4 sm:p-5" data-clone-settings>
          <div data-tags>
            <p className="text-xs font-medium text-muted-foreground">Tags on every clone</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {tagIds.map((id) => {
                const t = tagById.get(id) ?? { id, name: id };
                return <TagChip key={id} name={t.name} color={t.color} onRemove={() => setTagIds((ids) => ids.filter((x) => x !== id))} />;
              })}
              {newTags.map((n) => (
                <TagChip key={`new:${n}`} name={n} isNew onRemove={() => setNewTags((t) => t.filter((x) => x !== n))} />
              ))}
              {tagIds.length + newTags.length === 0 && <span className="text-xs text-muted-foreground">The clones will have no tags.</span>}
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
              <button type="button" className="pv-btn-ghost py-1.5 text-xs disabled:opacity-50" disabled={!cleanTagName(newTag)} onClick={addNewTag}>
                Add
              </button>
            </div>
          </div>

          <div>
            <p className="text-xs font-medium text-muted-foreground">Opt-out line on the kept variants</p>
            <div className="mt-2 flex flex-wrap gap-2" data-opt-out>
              {(
                [
                  ["keep", "Leave each as it is"],
                  ["add", "Add it where missing"],
                  ["remove", "Take it out"],
                ] as [OptOut, string][]
              ).map(([v, label]) => (
                <button key={v} type="button" className={`pv-chip text-xs ${optOut === v ? "border-accent bg-accent text-accent-foreground" : ""}`} onClick={() => setOptOut(v)}>
                  {label}
                </button>
              ))}
            </div>
          </div>

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
              disabled={!canStart}
              onClick={() => (armed ? void start() : setArmed(true))}
            >
              {starting ? <Spinner /> : <CopyIcon size={16} />}
              {armed
                ? `Really create ${chosen.length === 1 ? "it" : `all ${chosen.length}`}? Click again`
                : chosen.length > 0
                  ? `Create ${chosen.length} clone${chosen.length === 1 ? "" : "s"} with winning variants`
                  : "Create clones with winning variants"}
            </button>
            <span className="text-xs text-muted-foreground">
              {busy
                ? "A run is going — the next one can start when it finishes."
                : tooMany
                  ? `At most ${MAX_SEGMENTS} segments in one run.`
                  : chosen.length === 0
                    ? "Tick the segments to clone."
                    : "Runs in the background — you can close this page. Clones are drafts; nothing is launched. A segment with no winner yet is skipped."}
            </span>
          </div>
        </div>
      )}

      {error && (
        <div className="pv-card flex items-start gap-2 border-danger/40 p-4 text-sm text-danger" role="alert">
          <AlertIcon size={16} className="mt-0.5 shrink-0" />
          {error}
        </div>
      )}

      {jobs.length > 0 && (
        <div className="space-y-3" data-runs>
          <p className="text-sm font-medium">Runs</p>
          {jobs.map((j) => (
            <JobCard
              key={j.id}
              job={j}
              onStop={async () => {
                await abortWinningVariantsJob(j.id).catch(() => undefined);
                await loadJobs();
              }}
              onRemove={async () => {
                await deleteWinningVariantsJob(j.id).catch(() => undefined);
                await loadJobs();
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function JobCard({ job, onStop, onRemove }: { job: WinningVariantsJob; onStop: () => void; onRemove: () => void }) {
  const [open, setOpen] = useState(job.status === "running");
  const n = (st: SegmentOutcome["state"]) => job.segments.filter((s) => s.state === st).length;
  const finished = n("done") + n("skipped") + n("error");
  const pct = job.segments.length ? Math.round((100 * finished) / job.segments.length) : 0;
  const statusLabel: Record<WinningVariantsJob["status"], string> = {
    running: "Running",
    done: "Done",
    aborted: "Stopped",
    interrupted: "Paused by a restart",
    error: "Error",
  };
  return (
    <div className="pv-card p-4 sm:p-5" data-run-card={job.id}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`pv-chip text-xs ${job.status === "done" ? "text-success" : job.status === "error" ? "text-danger" : ""}`}>
          {job.status === "running" && <Spinner />}
          {statusLabel[job.status]}
        </span>
        <span className="text-sm font-medium">
          {job.segments.length} segment{job.segments.length === 1 ? "" : "s"} · {job.workspaceName}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">{new Date(job.createdAt).toLocaleString()}</span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {n("done")} cloned · {n("skipped")} skipped · {n("error")} failed
        {n("pending") + n("running") > 0 ? ` · ${n("pending") + n("running")} to go` : ""}
        {job.tagNames.length > 0 ? ` · tags: ${job.tagNames.join(", ")}` : ""}
        {job.optOut !== "keep" ? ` · opt-out line ${job.optOut === "add" ? "added" : "taken out"}` : ""}
      </p>
      {job.resumeBlocked && <p className="mt-1 text-xs text-muted-foreground">{job.resumeBlocked}</p>}
      {job.errors.map((e, i) => (
        <p key={i} className="mt-1 text-xs text-danger">
          {e}
        </p>
      ))}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="pv-btn-ghost py-1.5 text-xs" onClick={() => setOpen((o) => !o)}>
          {open ? "Hide details" : "Details"}
        </button>
        {job.status === "running" ? (
          <button type="button" className="pv-btn-ghost py-1.5 text-xs" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button type="button" className="pv-btn-ghost py-1.5 text-xs" onClick={onRemove}>
            Remove
          </button>
        )}
      </div>
      {open && (
        <ul className="mt-3 divide-y divide-border rounded-xl border border-border">
          {job.segments.map((s) => (
            <SegmentResult key={s.segment} s={s} />
          ))}
        </ul>
      )}
    </div>
  );
}

function SegmentResult({ s }: { s: SegmentOutcome }) {
  const icon =
    s.state === "done" ? (
      <CheckIcon size={14} className="text-success" />
    ) : s.state === "error" ? (
      <AlertIcon size={14} className="text-danger" />
    ) : s.state === "running" ? (
      <Spinner />
    ) : (
      <span className="inline-block h-3.5 w-3.5 rounded-full border border-border" />
    );
  return (
    <li className="px-3 py-2.5 text-sm" data-segment-result={s.segment}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0">{icon}</span>
        <div className="min-w-0 flex-1">
          <p className="font-medium">{s.segment}</p>
          {s.state === "done" && (
            <p className="text-xs text-muted-foreground">
              {s.name} · {s.kept ?? 0} of {s.of ?? 0} step-1 variants kept
              {s.credited ? ` · ${s.credited} follow-up positive${s.credited === 1 ? "" : "s"} credited to step 1` : ""}
              {s.verified === false ? " · not fully checked" : ""}
            </p>
          )}
          {s.state === "running" && <p className="text-xs text-muted-foreground">Reading the campaigns' figures and cloning…</p>}
          {s.state === "pending" && <p className="text-xs text-muted-foreground">Waiting.</p>}
          {s.note && <p className={`text-xs ${s.state === "error" ? "text-danger" : "text-muted-foreground"}`}>{s.note}</p>}
          {s.top && s.top.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
              {s.top.map((t) => (
                <li key={t.variation}>
                  {t.variation}: {formatNumber(t.positiveReplies)} positive · {formatNumber(t.replies)} replies · {formatNumber(t.sent)} sent
                  {t.campaignName ? ` · from ${t.campaignName}` : ""}
                </li>
              ))}
            </ul>
          )}
          {[...(s.problems ?? []), ...(s.warnings ?? [])].map((p, i) => (
            <p key={i} className="text-xs text-muted-foreground">
              {p}
            </p>
          ))}
        </div>
      </div>
    </li>
  );
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
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  loading?: boolean;
  placeholder: string;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</label>
      <div className="relative">
        <select className="pv-input appearance-none pr-9" value={value} disabled={loading} aria-label={label} onChange={(e) => onChange(e.target.value)}>
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

function errMessage(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
