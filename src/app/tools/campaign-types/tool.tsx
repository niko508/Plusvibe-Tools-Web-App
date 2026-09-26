"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Workspace, CampaignSummary } from "@/lib/plusvibe-types";
import type { CampaignTypesJob, CampaignTypesMode, CreatedRole, RoleNames } from "@/lib/jobs/campaign-types-types";
import {
  fetchWorkspaces,
  fetchCampaigns,
  startCampaignTypes,
  listCampaignTypesJobs,
  abortCampaignTypes,
  resumeCampaignTypes,
  deleteCampaignTypesJob,
  ApiClientError,
} from "@/lib/api-client";
import { DEFAULT_KINDS, KIND_HINTS, KIND_LABELS, KIND_ORDER, convertsOriginal, rolesFor, toggleKinds, type CampaignKind } from "@/lib/campaign-types/kinds";
import { MAX_RULES, validateRules, type SegmentRule } from "@/lib/campaign-types/segments";
import { ALLOC_ROLE_LABELS, classifyDestinations } from "@/lib/campaign-types/allocate";
import { useApiKey } from "@/lib/use-api-key";
import { formatNumber } from "@/lib/format";
import { ConnectPrompt } from "@/components/connect-prompt";
import { Spinner, EmptyState } from "@/components/ui";
import { LayersIcon, AlertIcon, ChevronDownIcon, CheckIcon, MoveIcon } from "@/components/icons";
import { deriveNames } from "@/lib/campaign-types/names";
import { isArchived, matchCompanions, normalizeName } from "@/lib/campaign-types/match";
import { shouldAutoResume } from "@/lib/campaign-types/resume";
import { JobCard } from "./job-card";
import { POOL_TAGS } from "@/lib/campaign-types/pools";
import { useGeneralSettings } from "@/lib/general-settings/use-general-settings";

const POLL_MS = 2000;
const JOBS_OPEN_KEY = "pv_ct_jobs_open";
/** Segment rows, besides the one for leads with no segment. */
const SEGMENT_ROWS = MAX_RULES - 1;

const ROLE_LABELS: Record<CreatedRole, string> = {
  blue: "Microsoft leads",
  optOut: "Opt-out copy on step 1",
  blueOptOut: "Microsoft leads + opt-out copy",
  signature: "Signs off with the signature",
  blueSignature: "Microsoft leads + signature sign-off",
};

interface SegmentRow {
  segment: string;
  campaignId: string;
}

const emptyRows = (): SegmentRow[] => Array.from({ length: SEGMENT_ROWS }, () => ({ segment: "", campaignId: "" }));

export function CampaignTypesTool() {
  const { hasKey, ready } = useApiKey();
  // Re-renders when General Settings arrive, for the pool tag names below.
  useGeneralSettings();

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [workspacesLoading, setWorkspacesLoading] = useState(false);

  const [campaigns, setCampaigns] = useState<CampaignSummary[] | null>(null);
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState("");

  const [rows, setRows] = useState<SegmentRow[]>(emptyRows);
  const [emptyTo, setEmptyTo] = useState("");
  const [kinds, setKinds] = useState<CampaignKind[]>(DEFAULT_KINDS);
  const [activate, setActivate] = useState(true);
  const [mode, setMode] = useState<CampaignTypesMode>("create");
  /** Fix Allocation: the campaigns the leads go to, and the segment to take. */
  const [destIds, setDestIds] = useState<string[]>([]);
  const [fixSegment, setFixSegment] = useState("");
  const [destFilter, setDestFilter] = useState("");

  const [jobs, setJobs] = useState<CampaignTypesJob[]>([]);
  const [jobsOpen, setJobsOpen] = useState(false);
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
    try {
      setJobsOpen(localStorage.getItem(JOBS_OPEN_KEY) === "1");
    } catch {
      // storage may be unavailable; the list just starts folded
    }
  }, []);

  function toggleJobs(next?: boolean) {
    setJobsOpen((prev) => {
      const v = next ?? !prev;
      try {
        localStorage.setItem(JOBS_OPEN_KEY, v ? "1" : "0");
      } catch {
        // fine
      }
      return v;
    });
  }

  useEffect(() => {
    if (ready && hasKey) {
      void loadWorkspaces();
      void refreshJobs();
    }
  }, [ready, hasKey, loadWorkspaces, refreshJobs]);

  // A run a server restart cut off is continued without being asked. The
  // server does this itself at start-up when it has a key of its own; when it
  // does not, the page does it with the key it holds, as soon as it sees one.
  // Tried once per run per page, so a refusal is shown rather than retried.
  const [resuming, setResuming] = useState<Set<string>>(() => new Set());
  const resumeTried = useRef(new Set<string>());
  const resume = useCallback(
    async (id: string) => {
      resumeTried.current.add(id);
      setResuming((prev) => new Set(prev).add(id));
      try {
        await resumeCampaignTypes(id);
        toggleJobs(true);
      } catch (err) {
        setError(errMessage(err));
      } finally {
        setResuming((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        await refreshJobs();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refreshJobs]
  );
  useEffect(() => {
    const now = Date.now();
    // Oldest first, so the queue comes back in the order it was in.
    const due = jobs
      .filter((j) => shouldAutoResume(j, now, jobs) && !resumeTried.current.has(j.id))
      .sort((a, b) => a.createdAt - b.createdAt);
    if (due.length === 0) return;
    void (async () => {
      for (const j of due) await resume(j.id);
    })();
  }, [jobs, resume]);

  // Queued jobs need polling too — nothing else tells the page when one of them
  // reaches the front and starts.
  const anyRunning = jobs.some((j) => j.status === "running" || j.status === "queued");
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => void refreshJobs(), POLL_MS);
    return () => clearInterval(t);
  }, [anyRunning, refreshJobs]);

  const loadCampaigns = useCallback(async (wsId: string) => {
    setCampaignsLoading(true);
    setCampaigns(null);
    setSelected([]);
    setRows(emptyRows());
    setEmptyTo("");
    setFilter("");
    setError(null);
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
  // Sub-sequences are separate campaign records and are never an original.
  const parents = useMemo(() => (campaigns ?? []).filter((c) => c.campaignType !== "subseq"), [campaigns]);
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? parents.filter((c) => c.name.toLowerCase().includes(q)) : parents;
  }, [parents, filter]);
  // In list order, whatever order they were ticked in, so the run is predictable.
  const sources = useMemo(() => parents.filter((c) => selected.includes(c.id)), [parents, selected]);
  const roles = useMemo(() => rolesFor(kinds), [kinds]);
  // Opt Out only turns each original into its Opt Out campaign in place.
  const converting = mode === "create" && convertsOriginal(kinds);
  // Opt Out only is a create-run choice; the Move leads tab goes back to the three.
  useEffect(() => {
    if (mode !== "create" && convertsOriginal(kinds)) setKinds([...DEFAULT_KINDS]);
  }, [mode, kinds]);

  // A rule pointing at a campaign that was un-ticked is cleared: the leads
  // it names can only go to one of the originals.
  useEffect(() => {
    setRows((prev) => prev.map((r) => (r.campaignId && !selected.includes(r.campaignId) ? { ...r, campaignId: "" } : r)));
    setEmptyTo((prev) => (prev && !selected.includes(prev) ? "" : prev));
  }, [selected]);

  // Fix Allocation reads the part each destination plays off its own name, so
  // what a pick will do can be shown before anything moves.
  const destinations = useMemo(
    () =>
      classifyDestinations(
        parents.filter((c) => destIds.includes(c.id)).map((c) => ({ campaignId: c.id, campaignName: c.name }))
      ),
    [parents, destIds]
  );
  const fixProblems = useMemo(() => {
    if (mode !== "fix") return [];
    const out = [...destinations.problems];
    if (sources.length === 0) out.push("Pick the campaigns to take the leads from.");
    if (destIds.length === 0) out.push("Pick the campaigns the leads go to.");
    if (!fixSegment.trim()) out.push("Type the segment whose leads should move.");
    const both = parents.find((c) => selected.includes(c.id) && destIds.includes(c.id));
    if (both) out.push(`"${both.name}" is both a source and a destination. Un-tick it from one of them.`);
    return out;
  }, [mode, destinations.problems, sources.length, destIds, fixSegment, parents, selected]);

  const rules = useMemo<SegmentRule[]>(() => {
    const nameOf = (id: string) => sources.find((s) => s.id === id)?.name ?? "";
    const out: SegmentRule[] = rows
      .filter((r) => r.segment.trim() !== "" || r.campaignId)
      .map((r) => ({ segment: r.segment, campaignId: r.campaignId, campaignName: nameOf(r.campaignId) }));
    if (emptyTo) out.push({ segment: null, campaignId: emptyTo, campaignName: nameOf(emptyTo) });
    return out;
  }, [rows, emptyTo, sources]);
  const ruleProblems = useMemo(() => validateRules(rules, sources.map((s) => s.id)), [rules, sources]);

  // Names already taken in this workspace. The job adopts an existing campaign
  // rather than making a second one under the same name, so a re-run after an
  // interruption is safe — this shows that before it happens. Archived ones
  // are skipped, matching what the run does.
  const existing = useMemo(() => {
    const map = new Map<string, CampaignSummary>();
    for (const c of parents) {
      if (isArchived(c)) continue;
      const key = normalizeName(c.name);
      if (!map.has(key)) map.set(key, c);
    }
    return map;
  }, [parents]);

  const previews = useMemo(
    () =>
      sources.map((source) => {
        const names = deriveNames(source.name);
        const rowsFor = roles.map((role) => ({
          role,
          name: names[role],
          reused: existing.get(normalizeName(names[role])) ?? null,
        }));
        const match = mode === "move" ? matchCompanions(source.name, parents, source.id, roles) : null;
        // Opt Out only: the name the original takes, and whether another
        // campaign already has it — which the run refuses.
        const renameTo = converting ? names.optOut : null;
        const renameTaken = renameTo ? (existing.get(normalizeName(renameTo)) ?? null) : null;
        return {
          source,
          names,
          rows: rowsFor,
          match,
          renameTo,
          renameTaken: renameTaken && renameTaken.id !== source.id ? renameTaken : null,
        };
      }),
    [sources, roles, existing, mode, parents, converting]
  );

  // Two originals whose copies would share a name — "X" and "🔵 X" picked
  // together, say — cannot both run; the server refuses it, and it is clearer
  // said here.
  const nameClash = useMemo(() => {
    const taken = new Map<string, string>();
    for (const p of previews) {
      if (p.renameTaken) return `"${p.source.name}" would be renamed "${p.renameTo}", but another campaign already has that name. Rename or archive that one first.`;
    }
    for (const s of sources) taken.set(normalizeName(s.name), s.name);
    for (const p of previews) {
      for (const r of p.rows) {
        const key = normalizeName(r.name);
        const holder = taken.get(key);
        if (holder) return `"${r.name}" would be both a copy of "${p.source.name}" and ${holder === r.name ? "an original you picked" : `a name belonging to "${holder}"`}. Un-tick one of them.`;
        taken.set(key, `a copy of "${p.source.name}"`);
      }
    }
    return null;
  }, [sources, previews]);

  const reusedCount = previews.reduce((n, p) => n + p.rows.filter((r) => r.reused).length, 0);
  const toCreate = previews.reduce((n, p) => n + p.rows.length, 0);
  const foundCount = previews.reduce((n, p) => n + (p.match?.matches.filter((m) => m.match).length ?? 0), 0);

  const activeJob = jobs.find((j) => j.status === "running") ?? null;
  const queuedCount = jobs.filter((j) => j.status === "queued").length;
  // Already-pending work no longer blocks Start — it queues behind it. The one
  // thing still refused is the same original twice over, which the server
  // rejects and the button disables here so it isn't even offered.
  const pendingClash = jobs.find(
    (j) => (j.status === "running" || j.status === "queued") && j.sources.some((s) => selected.includes(s.campaignId))
  );
  const canStart =
    sources.length > 0 &&
    (mode === "fix" || kinds.length > 0) &&
    (mode !== "fix" || fixProblems.length === 0) &&
    ruleProblems.length === 0 &&
    (mode === "fix" || !nameClash) &&
    !pendingClash &&
    !starting &&
    // A move needs somewhere to move to, but not every copy: the campaigns
    // that are there take the share of the ones that are not. A fix run is
    // told its destinations outright, so it has nothing to match.
    (mode === "create" || mode === "fix" || foundCount > 0);

  // --- Actions -------------------------------------------------------------
  function toggleSource(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function toggleKind(kind: CampaignKind) {
    setKinds((prev) => toggleKinds(prev, kind));
  }

  function setRow(i: number, patch: Partial<SegmentRow>) {
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  async function handleStart() {
    if (!canStart || startLock.current) return;
    startLock.current = true;
    setStarting(true);
    setError(null);
    try {
      await startCampaignTypes({
        mode,
        workspaceId: workspaceId!,
        workspaceName: workspaces.find((w) => w._id === workspaceId)?.name ?? "",
        sources: previews.map((p) => ({ campaignId: p.source.id, campaignName: p.source.name, names: p.names as RoleNames })),
        kinds: mode === "fix" ? [] : kinds,
        rules: mode === "fix" ? [] : rules,
        segment: mode === "fix" ? fixSegment.trim() : undefined,
        destinations:
          mode === "fix"
            ? destinations.destinations.map((d) => ({ campaignId: d.campaignId, campaignName: d.campaignName }))
            : undefined,
        activate: mode === "create" && activate,
      });
      setToast(activeJob || queuedCount > 0 ? "Added to the queue — it starts when the ones ahead finish" : "Job started — you can close this tab");
      setTimeout(() => setToast(null), 5000);
      toggleJobs(true);
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

  const campaignOptions = (
    <>
      <option value="">{sources.length === 0 ? "Pick the originals first…" : "Campaign…"}</option>
      {sources.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </>
  );

  return (
    <div className="space-y-5">
      <div className="pv-card space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="What to run">
          {(
            [
              ["create", "Create all types"],
              ["move", "Move leads"],
              ["fix", "Fix Allocation"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              className={`pv-chip ${mode === value ? "pv-chip-active" : "hover:text-foreground"}`}
              onClick={() => setMode(value)}
              data-mode={value}
            >
              {label}
            </button>
          ))}
          <span className="self-center text-xs text-muted-foreground">
            {mode === "create"
              ? "Sorts the leads by segment, builds the campaign types for each original, splits the leads into them and tags the pools."
              : mode === "move"
                ? "The copies already exist: this sorts by segment, splits each original's not-contacted leads into them and tags the pools."
                : "Puts leads where they should have gone: takes everything carrying one segment out of the campaigns you name and splits it into the ones you pick. Builds nothing; at the end, every campaign on both sides is checked and launched if it is not already active."}
          </span>
        </div>

        {/* Workspace + originals */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Workspace</label>
            <div className="relative">
              <select
                className="pv-input appearance-none pr-9"
                value={workspaceId ?? ""}
                disabled={workspacesLoading || workspaces.length === 0}
                onChange={(e) => setWorkspaceId(e.target.value)}
                aria-label="Workspace"
              >
                {workspacesLoading && <option>Loading workspaces…</option>}
                {!workspacesLoading && workspaces.length === 0 && <option>No workspaces found</option>}
                {!workspacesLoading &&
                  workspaces.map((w) => (
                    <option key={w._id} value={w._id}>
                      {w.name}
                    </option>
                  ))}
              </select>
              <ChevronDownIcon size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            </div>
          </div>

          <div>
            <div className="mb-1.5 flex items-baseline justify-between gap-2">
              <label className="block text-xs font-medium text-muted-foreground" htmlFor="ct-filter">
                {mode === "fix" ? "Take leads from" : "Original campaigns"}
              </label>
              <span className="text-[11px] text-muted-foreground" data-selected-count>
                {selected.length} selected
                {selected.length > 0 && (
                  <>
                    {" · "}
                    <button type="button" className="underline hover:text-foreground" onClick={() => setSelected([])}>
                      clear
                    </button>
                  </>
                )}
              </span>
            </div>
            <input
              id="ct-filter"
              type="text"
              className="pv-input mb-1.5 text-sm"
              placeholder={campaignsLoading ? "Loading campaigns…" : "Filter campaigns…"}
              value={filter}
              disabled={campaignsLoading || parents.length === 0}
              onChange={(e) => setFilter(e.target.value)}
            />
            <div className="max-h-52 overflow-y-auto rounded-xl border border-border" data-source-list>
              {campaignsLoading ? (
                <p className="p-3 text-xs text-muted-foreground">Loading campaigns…</p>
              ) : visible.length === 0 ? (
                <p className="p-3 text-xs text-muted-foreground">{parents.length === 0 ? "No campaigns in this workspace." : "Nothing matches."}</p>
              ) : (
                visible.map((c) => {
                  const on = selected.includes(c.id);
                  return (
                    <label
                      key={c.id}
                      className={`flex cursor-pointer items-center gap-2 border-b border-border/60 px-3 py-1.5 text-sm last:border-b-0 hover:bg-muted/50 ${on ? "bg-accent/5" : ""}`}
                    >
                      <input type="checkbox" checked={on} onChange={() => toggleSource(c.id)} aria-label={`Pick ${c.name}`} data-source-option={c.id} />
                      <span className="min-w-0 flex-1 truncate">{c.name}</span>
                      {isArchived(c) && <span className="shrink-0 text-[11px] text-muted-foreground">archived</span>}
                    </label>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* Fix Allocation: where the leads go, and which segment moves. */}
        {mode === "fix" && (
          <div className="space-y-3" data-fix>
            <div>
              <div className="mb-1.5 flex items-baseline justify-between gap-2">
                <label className="block text-xs font-medium text-muted-foreground" htmlFor="fix-dest-filter">
                  Move them into
                </label>
                <span className="text-[11px] text-muted-foreground">
                  {destIds.length} selected
                  {destIds.length > 0 && (
                    <>
                      {" · "}
                      <button type="button" className="underline hover:text-foreground" onClick={() => setDestIds([])}>
                        clear
                      </button>
                    </>
                  )}
                </span>
              </div>
              <p className="mb-1.5 text-xs text-muted-foreground">
                Pick the whole family. Which one a lead goes to is read off each campaign&apos;s own name — 🔵 is the
                Microsoft side, &quot;Opt Out&quot; and &quot;Signature&quot; the variants — and the leads are then divided
                exactly as a normal run divides them. A side you leave unpicked keeps its leads where they are.
              </p>
              <input
                id="fix-dest-filter"
                type="text"
                className="pv-input mb-1.5 text-sm"
                placeholder="Filter campaigns…"
                value={destFilter}
                disabled={campaignsLoading || parents.length === 0}
                onChange={(e) => setDestFilter(e.target.value)}
                aria-label="Filter destination campaigns"
              />
              <div className="max-h-52 overflow-y-auto rounded-xl border border-border" data-dest-list>
                {parents.filter((c) => !isArchived(c) && c.name.toLowerCase().includes(destFilter.trim().toLowerCase())).length === 0 ? (
                  <p className="p-3 text-xs text-muted-foreground">Nothing matches.</p>
                ) : (
                  parents
                    .filter((c) => !isArchived(c) && c.name.toLowerCase().includes(destFilter.trim().toLowerCase()))
                    .map((c) => {
                      const on = destIds.includes(c.id);
                      const role = destinations.destinations.find((d) => d.campaignId === c.id)?.role;
                      return (
                        <label
                          key={c.id}
                          className={`flex cursor-pointer items-center gap-2 border-b border-border/60 px-3 py-1.5 text-sm last:border-b-0 hover:bg-muted/50 ${on ? "bg-accent/5" : ""}`}
                        >
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => setDestIds((prev) => (prev.includes(c.id) ? prev.filter((x) => x !== c.id) : [...prev, c.id]))}
                            aria-label={`Move into ${c.name}`}
                            data-dest-option={c.id}
                          />
                          <span className="min-w-0 flex-1 truncate">{c.name}</span>
                          {on && role && (
                            <span className="shrink-0 text-[11px] text-accent" data-dest-role={c.id}>
                              {ALLOC_ROLE_LABELS[role]}
                            </span>
                          )}
                        </label>
                      );
                    })
                )}
              </div>
            </div>

            <div className="max-w-xs">
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground" htmlFor="fix-segment">
                Segment to move
              </label>
              <input
                id="fix-segment"
                type="text"
                className="pv-input text-sm"
                placeholder="app"
                value={fixSegment}
                onChange={(e) => setFixSegment(e.target.value)}
                aria-label="Segment to move"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Matched exactly against each lead&apos;s Segment field, bar case and spaces. Every not-contacted lead
                carrying it moves; everything else is left alone.
              </p>
            </div>

            {fixProblems.length > 0 && (
              <p className="flex gap-1.5 text-xs text-warning" data-fix-problems>
                <AlertIcon size={13} className="mt-0.5 shrink-0" />
                <span>{fixProblems.join(" ")}</span>
              </p>
            )}
          </div>
        )}

        {/* Segments */}
        {mode !== "fix" && (
        <div data-segments>
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">Segments</div>
          <p className="mb-2 text-xs text-muted-foreground">
            Before anything is built, every lead is moved to the campaign its Segment field names. Only the originals picked
            above can be chosen. A segment on no row stays where it is.
          </p>
          <div className="space-y-2">
            {rows.map((r, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr]" data-segment-row={i + 1}>
                <input
                  type="text"
                  className="pv-input text-sm"
                  placeholder={`Segment ${i + 1}`}
                  value={r.segment}
                  onChange={(e) => setRow(i, { segment: e.target.value })}
                  aria-label={`Segment ${i + 1}`}
                />
                <div className="relative">
                  <select
                    className="pv-input appearance-none pr-9 text-sm"
                    value={r.campaignId}
                    disabled={sources.length === 0}
                    onChange={(e) => setRow(i, { campaignId: e.target.value })}
                    aria-label={`Campaign for segment ${i + 1}`}
                  >
                    {campaignOptions}
                  </select>
                  <ChevronDownIcon size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                </div>
              </div>
            ))}
            <div className="grid gap-2 sm:grid-cols-[1fr_1fr]" data-segment-row="empty">
              <div className="pv-input flex items-center text-sm text-muted-foreground">Leads with no segment</div>
              <div className="relative">
                <select
                  className="pv-input appearance-none pr-9 text-sm"
                  value={emptyTo}
                  disabled={sources.length === 0}
                  onChange={(e) => setEmptyTo(e.target.value)}
                  aria-label="Campaign for leads with no segment"
                >
                  <option value="">{sources.length === 0 ? "Pick the originals first…" : "Leave them where they are"}</option>
                  {sources.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <ChevronDownIcon size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              </div>
            </div>
          </div>
          {ruleProblems.length > 0 && (
            <p className="mt-2 flex gap-1.5 text-xs text-warning" data-rule-problems>
              <AlertIcon size={13} className="mt-0.5 shrink-0" />
              <span>{ruleProblems.join(" ")}</span>
            </p>
          )}
        </div>
        )}

        {/* Campaign types */}
        {mode !== "fix" && (
        <div data-kinds>
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">Campaign types</div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {KIND_ORDER.filter((k) => mode === "create" || k !== "optOutOnly").map((k) => {
              const on = kinds.includes(k);
              return (
                <label
                  key={k}
                  data-kind={k}
                  className={`flex cursor-pointer items-start gap-2 rounded-xl border p-2.5 ${on ? "border-accent/50 bg-accent/5" : "border-border"} ${k === "optOutOnly" ? "border-dashed" : ""}`}
                >
                  <input type="checkbox" className="mt-0.5" checked={on} onChange={() => toggleKind(k)} aria-label={`Type ${KIND_LABELS[k]}`} />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{KIND_LABELS[k]}</span>
                    <span className="block text-[11px] text-muted-foreground">{KIND_HINTS[k]}</span>
                  </span>
                </label>
              );
            })}
          </div>
          {converting && (
            <p className="mt-2 flex gap-1.5 text-xs text-muted-foreground" data-opt-out-only-note>
              <AlertIcon size={13} className="mt-0.5 shrink-0" />
              <span>
                Opt Out only changes the originals themselves — including the campaigns your segments point to: step 1 of each gets the
                current opt-out line (old opt-out text is swapped for it, variants that already have it are left alone) and each is renamed
                to its Opt Out name. Only the 🔵 Opt Out copies are created. It can&apos;t be combined with the other types.
              </span>
            </p>
          )}
          {kinds.length === 0 && (
            <p className="mt-2 flex gap-1.5 text-xs text-warning">
              <AlertIcon size={13} className="mt-0.5 shrink-0" />
              <span>Tick at least one type.</span>
            </p>
          )}
        </div>
        )}

        {/* Preview */}
        {mode !== "fix" && sources.length > 0 && roles.length > 0 && (
          <div className="rounded-xl border border-border p-3 sm:p-4" data-preview>
            <h3 className="mb-1 text-sm font-medium">
              {mode === "create"
                ? converting
                  ? `${sources.length === 1 ? "The original is" : `${sources.length} originals are`} turned into Opt Out, and ${formatNumber(toCreate)} 🔵 cop${toCreate === 1 ? "y is" : "ies are"} created`
                  : `${formatNumber(toCreate)} campaign${toCreate === 1 ? "" : "s"} will be created from ${sources.length === 1 ? "this original" : `${sources.length} originals`}`
                : foundCount === 0
                  ? "None of the copies are in this workspace"
                  : `Leads go to the ${formatNumber(foundCount)} cop${foundCount === 1 ? "y" : "ies"} that ${foundCount === 1 ? "is" : "are"} there`}
            </h3>
            <p className="mb-3 text-xs text-muted-foreground">
              {mode === "create"
                ? "Duplicated with their sub-sequences. Leads aren't copied — they're split deliberately afterwards. Google leads stay in the plain campaigns; Microsoft and other-ESP leads go to the 🔵 ones."
                : "Found by name in this workspace. Archived campaigns don't count — an active, paused or completed one all take leads. Nothing is created, no copy is changed and nothing is launched."}
            </p>
            <div className="space-y-3">
              {previews.map((p) => (
                <div key={p.source.id} data-preview-source={p.source.id}>
                  <div className="mb-1 truncate text-xs font-medium">{p.source.name}</div>
                  <div className="space-y-1.5">
                    {mode === "create" && p.renameTo && (
                      <div className="flex flex-col gap-1 rounded-lg border border-border/70 px-2.5 py-2 sm:flex-row sm:items-center sm:justify-between" data-convert-row={p.source.id}>
                        <div className="min-w-0">
                          <div className="truncate font-mono text-xs">{p.renameTo}</div>
                          <div className="mt-0.5 text-[11px] text-muted-foreground">
                            The original itself — opt-out line on step 1{normalizeName(p.renameTo) === normalizeName(p.source.name) ? "; already named for it" : ", renamed"}
                          </div>
                        </div>
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${p.renameTaken ? "bg-danger/10 text-danger" : "bg-accent/10 text-accent"}`}>
                          {p.renameTaken ? "name already taken" : normalizeName(p.renameTo) === normalizeName(p.source.name) ? "will be updated" : "will be renamed"}
                        </span>
                      </div>
                    )}
                    {mode === "create"
                      ? p.rows.map((r) => (
                          <div key={r.role} className="flex flex-col gap-1 rounded-lg border border-border/70 px-2.5 py-2 sm:flex-row sm:items-center sm:justify-between">
                            <div className="min-w-0">
                              <div className="truncate font-mono text-xs">{r.name}</div>
                              <div className="mt-0.5 text-[11px] text-muted-foreground">{ROLE_LABELS[r.role]}</div>
                            </div>
                            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${r.reused ? "bg-warning/10 text-warning" : "bg-success/10 text-success"}`}>
                              {r.reused ? "already exists — will be reused" : "will be created"}
                            </span>
                          </div>
                        ))
                      : (p.match?.matches ?? []).map((m) => (
                          <div key={m.role} className="flex flex-col gap-1 rounded-lg border border-border/70 px-2.5 py-2 sm:flex-row sm:items-center sm:justify-between" data-move-row={m.role}>
                            <div className="min-w-0">
                              <div className="truncate font-mono text-xs">{m.match?.name ?? m.expectedName}</div>
                              <div className="mt-0.5 text-[11px] text-muted-foreground">{ROLE_LABELS[m.role]}</div>
                            </div>
                            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${m.match ? "bg-success/10 text-success" : "bg-danger/10 text-danger"}`}>
                              {m.match ? (m.loose ? "found — check it is the right one" : "found") : m.ambiguous ? "two share this name — skipped" : "not found — skipped"}
                            </span>
                          </div>
                        ))}
                  </div>
                </div>
              ))}
            </div>
            {mode === "create" && reusedCount > 0 && (
              <p className="mt-3 text-xs text-muted-foreground">
                {reusedCount === 1 ? "A campaign" : `${reusedCount} campaigns`} with {reusedCount === 1 ? "this name" : "these names"} already exist
                {reusedCount === 1 ? "s" : ""}, so {reusedCount === 1 ? "it" : "they"} will be used as-is rather than duplicated again. That&apos;s what makes
                re-running after an interrupted job safe.
              </p>
            )}
            {nameClash && (
              <p className="mt-3 flex gap-1.5 text-xs text-warning" data-name-clash>
                <AlertIcon size={13} className="mt-0.5 shrink-0" />
                <span>{nameClash}</span>
              </p>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              At the end every plain campaign is tagged <span className="font-mono">{POOL_TAGS.google.name}</span> and every 🔵 one{" "}
              <span className="font-mono">{POOL_TAGS.microsoft.name}</span>.
            </p>
            {mode === "create" && (
              <label className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
                <input type="checkbox" className="mt-0.5" checked={activate} onChange={(e) => setActivate(e.target.checked)} />
                <span>Activate every campaign at the end, sub-sequences included. Untick to leave the copies as drafts and launch them yourself.</span>
              </label>
            )}
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger">
            <AlertIcon size={16} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="pv-btn-primary disabled:opacity-50" disabled={!canStart} onClick={handleStart} data-start>
            {starting ? <Spinner /> : mode === "move" ? <MoveIcon size={16} /> : <LayersIcon size={16} />}
            {activeJob || queuedCount > 0 ? "Add to queue" : mode === "move" ? "Move leads" : "Start"}
          </button>
          {pendingClash ? (
            <span className="text-xs text-warning">
              One of these campaigns is already {pendingClash.status === "running" ? "being processed" : "in the queue"}.
            </span>
          ) : activeJob ? (
            <span className="text-xs text-muted-foreground">
              A job is running{queuedCount > 0 ? ` and ${formatNumber(queuedCount)} more ${queuedCount === 1 ? "is" : "are"} queued` : ""}. This one waits its
              turn — jobs run one at a time, in the order you start them, so the campaigns come out in order.
            </span>
          ) : null}
        </div>
      </div>

      {/* Jobs, folded away until wanted */}
      <div className="space-y-3">
        <button
          type="button"
          className="flex w-full items-center justify-between rounded-xl border border-border px-3 py-2 text-left text-sm font-semibold hover:bg-muted/50"
          onClick={() => toggleJobs()}
          aria-expanded={jobsOpen}
          data-jobs-toggle
        >
          <span>
            Jobs
            {jobs.length > 0 && <span className="ml-2 font-normal text-muted-foreground">{formatNumber(jobs.length)}</span>}
            {anyRunning && (
              <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">
                <Spinner size={10} /> {activeJob ? "running" : "queued"}
              </span>
            )}
          </span>
          <ChevronDownIcon size={16} className={`text-muted-foreground transition-transform ${jobsOpen ? "rotate-180" : ""}`} />
        </button>
        {jobsOpen &&
          (jobs.length === 0 ? (
            <EmptyState icon={<LayersIcon />} title="No jobs yet">
              Pick the original campaigns and start — the run keeps going even if you close this tab.
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
                onResume={resume}
                resuming={resuming.has(job.id)}
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
          ))}
      </div>

      {toast && (
        <div className="fixed bottom-5 right-5 z-50 animate-fade-in">
          <div className="flex items-center gap-3 rounded-xl border border-success/40 bg-success/15 px-4 py-3 shadow-card backdrop-blur">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-success/20 text-success">
              <CheckIcon size={14} />
            </span>
            <span className="text-sm font-medium text-success">{toast}</span>
            <button type="button" onClick={() => setToast(null)} className="ml-1 text-success/70 transition hover:text-success" aria-label="Dismiss">
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
