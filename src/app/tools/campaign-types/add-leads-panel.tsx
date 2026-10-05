"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CampaignSummary } from "@/lib/plusvibe-types";
import type { CampaignKind } from "@/lib/campaign-types/kinds";
import type { RoleNames } from "@/lib/jobs/campaign-types-types";
import { deriveNames } from "@/lib/campaign-types/names";
import { ALL_COMPANION_ROLES, matchCompanions } from "@/lib/campaign-types/match";
import { familyBase, isOriginal, planAddLeads, type SegmentCount } from "@/lib/campaign-types/add-leads";
import { findIndustry, industryForCampaign, type Industry } from "@/lib/campaign-types/industries";
import { DEFAULT_SEGMENT_ROWS, MAX_SEGMENTS } from "@/lib/campaign-types/segments";
import { ApiClientError, deleteIndustry, previewAddLeads, saveIndustry, startCampaignTypes } from "@/lib/api-client";
import { IndustryPicker } from "./industry-picker";
import { formatNumber } from "@/lib/format";
import { Spinner } from "@/components/ui";
import { AlertIcon, ChevronDownIcon, MoveIcon, RefreshIcon } from "@/components/icons";

// Add More Leads: pick the campaign a new batch was uploaded to and the
// industry, and each segment's leads go to the newest campaign named for it,
// split across that family's 🔵, Opt Out and Signature copies — whichever it
// has. Leads with no segment, or one not listed, stay with the source and are
// split across its family. Only the source's not-contacted leads move; the
// other families keep the leads they already had.

const ROLE_SHORT: Record<string, string> = {
  blue: "Microsoft leads",
  optOut: "Google leads, opt-out line",
  blueOptOut: "Microsoft leads, opt-out line",
  signature: "Google leads, signature sign-off",
  blueSignature: "Microsoft leads, signature sign-off",
};

const errMessage = (err: unknown) => (err instanceof ApiClientError || err instanceof Error ? err.message : "Something went wrong.");

export function AddLeadsPanel({
  workspaceId,
  workspaceName,
  campaigns,
  campaignsLoading,
  industries,
  onIndustries,
  queued,
  onStarted,
  workspaceSelect,
}: {
  workspaceId: string | null;
  workspaceName: string;
  /** Every campaign in the workspace, copies included — they are looked up by name. */
  campaigns: CampaignSummary[];
  campaignsLoading: boolean;
  industries: Industry[];
  onIndustries: (list: Industry[]) => void;
  /** A run is going or waiting: this one queues behind it. */
  queued: boolean;
  onStarted: (queuedBehind: boolean) => void | Promise<void>;
  workspaceSelect: React.ReactNode;
}) {
  const [sourceId, setSourceId] = useState("");
  const [industry, setIndustry] = useState("");
  const [segments, setSegments] = useState<string[]>(() => Array(DEFAULT_SEGMENT_ROWS).fill(""));
  /** Families picked by hand, by segment (lower-case). */
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  /** What the source's not-contacted leads carry, read when it is picked. */
  const [found, setFound] = useState<{ total: number; segments: SegmentCount[]; hitPageLimit: boolean } | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [readTick, setReadTick] = useState(0);

  // A new workspace: nothing picked carries over, except the industry and its segments.
  useEffect(() => {
    setSourceId("");
    setPicked({});
  }, [workspaceId]);

  // The source's leads, counted by segment — only when asked for: reading a
  // big campaign takes a while, and the run doesn't need it.
  useEffect(() => {
    setFound(null);
    setReadError(null);
    setReading(false);
    if (!workspaceId || !sourceId || readTick === 0) return;
    const ctrl = new AbortController();
    setReading(true);
    previewAddLeads({ workspaceId, campaignId: sourceId }, ctrl.signal)
      .then((r) => setFound(r))
      .catch((err) => {
        if (!ctrl.signal.aborted) setReadError(errMessage(err));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setReading(false);
      });
    return () => ctrl.abort();
  }, [workspaceId, sourceId, readTick]);
  // A different campaign starts unread.
  useEffect(() => setReadTick(0), [workspaceId, sourceId]);

  const originals = useMemo(() => campaigns.filter(isOriginal), [campaigns]);
  const source = originals.find((c) => c.id === sourceId) ?? null;

  // Picking the campaign picks the industry it is named for, with its
  // segments; a name that matches no saved industry leaves both empty, to be
  // picked by hand.
  useEffect(() => {
    if (!source) return;
    const match = industryForCampaign(source.name, industries);
    setPicked({});
    if (match) {
      setIndustry(match.name);
      const saved = match.segments.slice(0, MAX_SEGMENTS);
      setSegments(Array.from({ length: Math.max(DEFAULT_SEGMENT_ROWS, saved.length) }, (_, k) => saved[k] ?? ""));
    } else {
      setIndustry("");
      setSegments(Array(DEFAULT_SEGMENT_ROWS).fill(""));
    }
    // Only when the campaign changes: industries saved later don't undo a hand pick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId]);
  const typed = segments.map((s) => s.trim()).filter(Boolean);
  /** What this industry learned from earlier hand picks: segment → family name. */
  const remembered = useMemo(() => findIndustry(industries, industry)?.families ?? {}, [industries, industry]);
  const plan = useMemo(
    () => planAddLeads(source, typed, originals, picked, found?.segments ?? null, remembered),
    [source, typed.join("|"), originals, picked, found, remembered] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const noSegmentCount = found?.segments.find((f) => f.segment === "")?.count ?? 0;
  /** Leads each family takes, by campaign id: the source keeps whatever no row sends elsewhere. */
  const leadsFor = useMemo(() => {
    if (!found || !source) return new Map<string, number>();
    const m = new Map<string, number>();
    let sent = 0;
    for (const r of plan.rows) {
      if (!r.familyId || !r.count || r.familyId === source.id) continue;
      m.set(r.familyId, (m.get(r.familyId) ?? 0) + r.count);
      sent += r.count;
    }
    m.set(source.id, found.total - sent);
    return m;
  }, [found, source, plan.rows]);

  // Each family taking leads, and the copies it has.
  const families = useMemo(() => {
    const list = source ? [source, ...plan.arrivalFamilies] : [];
    return list.map((c) => {
      const match = matchCompanions(c.name, campaigns, c.id, ALL_COMPANION_ROLES);
      return {
        campaign: c,
        isSource: c.id === source?.id,
        found: match.matches.filter((m) => m.match).map((m) => m.role),
        copies: match.matches.filter((m) => m.match).map((m) => ({ role: m.role, name: m.match!.name })),
        ambiguous: match.matches.filter((m) => m.ambiguous).map((m) => m.expectedName),
      };
    });
  }, [source, plan.arrivalFamilies, campaigns]);

  // The copies to split into: every kind some family has. A family without one
  // simply isn't sent any of that kind's share.
  const kinds = useMemo<CampaignKind[]>(() => {
    const has = (roles: string[]) => families.some((f) => f.found.some((r) => roles.includes(r)));
    return [
      "default" as const,
      ...(has(["optOut", "blueOptOut"]) ? ["optOut" as const] : []),
      ...(has(["signature", "blueSignature"]) ? ["signature" as const] : []),
    ];
  }, [families]);

  const noCopies = families.filter((f) => f.found.length === 0);
  const problems = [
    ...plan.problems,
    ...(workspaceId ? [] : ["Pick the workspace."]),
    ...noCopies.map((f) => `"${f.campaign.name}" has no 🔵, Opt Out or Signature copies in this workspace, so its leads would have nowhere to be split to.`),
    ...families.flatMap((f) => f.ambiguous.map((n) => `More than one campaign is called "${n}". Rename one so there is no telling them apart by mistake.`)),
  ];
  const canStart = problems.length === 0 && !starting && !!source && (!found || found.total > 0);

  function pickIndustry(i: Industry) {
    setIndustry(i.name);
    if (i.segments.length > 0) {
      const saved = i.segments.slice(0, MAX_SEGMENTS);
      setSegments(Array.from({ length: Math.max(DEFAULT_SEGMENT_ROWS, saved.length) }, (_, k) => saved[k] ?? ""));
      setPicked({});
    }
  }

  async function remember(name: string, allowEmpty: boolean, families?: Record<string, string>) {
    if (!name.trim() || (!allowEmpty && typed.length === 0)) return;
    setSaving(true);
    try {
      const r = await saveIndustry({ name, segments: typed, ...(families && Object.keys(families).length > 0 ? { families } : {}) });
      onIndustries(r.industries);
      setIndustry(r.saved.name);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function start() {
    if (!canStart || !source || !workspaceId || lock.current) return;
    lock.current = true;
    setStarting(true);
    setError(null);
    try {
      const entry = (c: { id: string; name: string }, arrivalsOnly: boolean) => ({
        campaignId: c.id,
        campaignName: c.name,
        names: deriveNames(c.name) as unknown as RoleNames,
        ...(arrivalsOnly ? { arrivalsOnly: true } : {}),
      });
      await startCampaignTypes({
        mode: "move",
        workspaceId,
        workspaceName,
        sources: [entry(source, false), ...plan.arrivalFamilies.map((c) => entry(c, true))],
        kinds,
        rules: plan.rules,
        activate: false,
        onlyExisting: true,
        activateWorkspace: true,
      });
      // Learn from the hand picks: next time these segments find the newest
      // campaign of the family chosen for them now.
      const learned: Record<string, string> = {};
      for (const r of plan.rows) if (!r.auto && r.familyName) learned[r.segment.toLowerCase()] = familyBase(r.familyName);
      if (industry.trim()) void remember(industry, false, learned);
      await onStarted(queued);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      lock.current = false;
      setStarting(false);
    }
  }

  const sourceSegment = plan.rows.find((r) => r.isSource)?.segment;

  return (
    <div className="space-y-4" data-add-leads>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>{workspaceSelect}</div>
        <div>
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground" htmlFor="al-source">
            Campaign the new leads are in
          </label>
          <div className="relative">
            <select
              id="al-source"
              className="pv-input appearance-none pr-9"
              value={sourceId}
              disabled={campaignsLoading || originals.length === 0}
              onChange={(e) => setSourceId(e.target.value)}
              aria-label="Source campaign"
            >
              <option value="">{campaignsLoading ? "Loading campaigns…" : "Pick the campaign…"}</option>
              {originals.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <ChevronDownIcon size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">Only its not-contacted leads are moved.</p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <IndustryPicker
          industries={industries}
          value={industry}
          segments={typed}
          saving={saving}
          onType={setIndustry}
          onPick={pickIndustry}
          onAdd={(name) => {
            setIndustry(name);
            void remember(name, true);
          }}
          onForget={async (name) => {
            try {
              onIndustries((await deleteIndustry(name)).industries);
            } catch (err) {
              setError(errMessage(err));
            }
          }}
          onSave={() => void remember(industry, false)}
        />
        <div>
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">Segments</div>
          <div className="space-y-1.5">
            {segments.map((s, i) => (
              <div key={i} className="flex gap-1.5" data-al-segment-row={i + 1}>
                <input
                  type="text"
                  className="pv-input text-sm"
                  placeholder={`Segment ${i + 1}`}
                  value={s}
                  onChange={(e) => setSegments((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))}
                  aria-label={`Segment ${i + 1}`}
                />
                <button
                  type="button"
                  className="flex w-9 shrink-0 items-center justify-center rounded-xl text-lg leading-none text-muted-foreground hover:bg-muted hover:text-foreground"
                  // The last one left is only cleared, so there is always a row to type in.
                  onClick={() => setSegments((prev) => (prev.length > 1 ? prev.filter((_, j) => j !== i) : [""]))}
                  aria-label={`Remove segment ${i + 1}`}
                  title="Remove this segment"
                >
                  ×
                </button>
              </div>
            ))}
            {segments.length < MAX_SEGMENTS && (
              <button
                type="button"
                className="pv-btn-ghost px-2 py-1 text-xs"
                onClick={() => setSegments((prev) => (prev.length < MAX_SEGMENTS ? [...prev, ""] : prev))}
                data-al-add-segment
              >
                + Add segment
              </button>
            )}
          </div>
          {(findIndustry(industries, industry)?.segments.length ?? 0) > 0 && typed.length > 0 && (
            <p className="mt-1.5 text-[11px] text-muted-foreground">Filled in from the industry; change them here if this batch differs.</p>
          )}
        </div>
      </div>

      {source && (
        <div className="rounded-xl border border-border" data-al-plan>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
            <span className="text-xs font-medium">Where the leads go</span>
            <span className="flex items-center gap-2 text-[11px] text-muted-foreground" data-al-read>
              {reading ? (
                <>
                  <Spinner size={11} /> Reading the leads in {source.name}… (optional — you can add the leads now)
                </>
              ) : readError ? (
                <span className="text-warning">
                  Couldn&apos;t read the leads: {readError}{" "}
                  <button type="button" className="underline" onClick={() => setReadTick((n) => n + 1)}>
                    Try again
                  </button>
                </span>
              ) : !found ? (
                <button type="button" className="underline hover:text-foreground" onClick={() => setReadTick(1)} data-al-check>
                  Check the leads first (optional)
                </button>
              ) : found ? (
                <>
                  {formatNumber(found.total)} not-contacted lead{found.total === 1 ? "" : "s"}
                  {found.hitPageLimit ? " (the first ones — there are more)" : ""}
                  <button type="button" className="pv-btn-ghost px-1.5 py-0.5 text-[11px]" onClick={() => setReadTick((n) => n + 1)} title="Read again">
                    <RefreshIcon size={11} />
                  </button>
                </>
              ) : null}
            </span>
          </div>
          <div className="divide-y divide-border">
            {plan.rows.map((r) => {
              const unknown = !r.familyId && r.count !== 0;
              return (
                <div
                  key={r.segment}
                  className={`grid gap-2 px-3 py-2 sm:grid-cols-[200px_1fr] sm:items-center ${unknown ? "bg-warning/5" : ""} ${r.count === 0 ? "opacity-60" : ""}`}
                  data-al-row={r.segment}
                >
                  <div className="text-sm">
                    <span className="font-medium">{r.segment}</span>
                    <span className="ml-1.5 text-xs text-muted-foreground" data-al-count>
                      {r.count === null ? "" : `${formatNumber(r.count)} lead${r.count === 1 ? "" : "s"}`}
                    </span>
                    {!r.fromIndustry && <div className="text-[11px] text-muted-foreground">in the leads, not in the industry</div>}
                  </div>
                  <div>
                    <div className="relative">
                      <select
                        className="pv-input appearance-none py-1.5 pr-9 text-sm"
                        value={r.familyId ?? ""}
                        disabled={r.count === 0}
                        onChange={(e) => setPicked((prev) => ({ ...prev, [r.segment.toLowerCase()]: e.target.value }))}
                        aria-label={`Family for ${r.segment}`}
                      >
                        <option value="">Stays in {source.name}</option>
                        {originals.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                      <ChevronDownIcon size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    </div>
                    <p className={`mt-1 text-[11px] ${unknown ? "text-warning" : "text-muted-foreground"}`} data-al-note>
                      {r.count === 0
                        ? "None of the leads carry it."
                        : r.isSource
                          ? "The source's own family: these leads stay and are split here."
                          : r.familyId
                            ? r.remembered
                              ? `Remembered from last time: the newest "${familyBase(r.familyName ?? "")}" campaign.`
                              : r.auto
                              ? r.candidates > 1
                                ? `The newest of ${formatNumber(r.candidates)} campaigns named for it, by the month in the name.`
                                : "Found by name."
                              : industry.trim()
                                ? `Picked by hand — ${industry.trim()} will remember it when the leads are added.`
                                : "Picked by hand."
                            : "Couldn't find a campaign named for it — these stay in the source unless you pick one."}
                    </p>
                  </div>
                </div>
              );
            })}
            <div className="grid gap-2 px-3 py-2 sm:grid-cols-[200px_1fr] sm:items-center" data-al-row="none">
              <div className="text-sm">
                <span className="text-muted-foreground">No segment</span>
                {found && <span className="ml-1.5 text-xs text-muted-foreground">{formatNumber(noSegmentCount)} lead{noSegmentCount === 1 ? "" : "s"}</span>}
              </div>
              <div className="text-sm">
                Stays in <span className="font-medium">{source.name}</span>
                {sourceSegment ? <span className="text-muted-foreground"> — with the {sourceSegment} leads</span> : null}, and is split across its family.
              </div>
            </div>
          </div>
        </div>
      )}

      {families.length > 0 && (
        <div className="space-y-2" data-al-families>
          <div className="text-xs font-medium text-muted-foreground">Campaigns that will get leads</div>
          {families.map((f) => (
            <div key={f.campaign.id} className="rounded-lg border border-border/70 px-3 py-2" data-al-family={f.campaign.id}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-medium">{f.campaign.name}</span>
                <span className="text-xs text-muted-foreground">
                  {found
                    ? `${formatNumber(leadsFor.get(f.campaign.id) ?? 0)} lead${(leadsFor.get(f.campaign.id) ?? 0) === 1 ? "" : "s"}${f.isSource ? " stay in this family" : " move in"}`
                    : f.isSource
                      ? "its own segment, and leads with none or with a segment not listed"
                      : `the ${plan.rows.filter((r) => r.familyId === f.campaign.id).map((r) => r.segment).join(", ")} leads`}
                </span>
              </div>
              {f.copies.length === 0 ? (
                <p className="mt-1 text-xs text-danger">No copies found — nothing to split into.</p>
              ) : (
                <ul className="mt-1 space-y-0.5 text-xs" data-al-campaigns>
                  <li className="text-muted-foreground">
                    {f.campaign.name} <span className="text-[11px]">· Google leads</span>
                  </li>
                  {f.copies.map((c) => (
                    <li key={c.role} className="text-muted-foreground">
                      {c.name} <span className="text-[11px]">· {ROLE_SHORT[c.role]}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          <p className="text-[11px] text-muted-foreground">
            Within each family, Google leads stay on the 🟡 side and Microsoft and other providers go to the 🔵 side, shared evenly across the Opt Out and Signature copies it has. A copy a family doesn&apos;t have just isn&apos;t sent anything.{" "}
            {families.some((f) => !f.isSource) ? "The other families keep the leads they already had." : ""}
          </p>
        </div>
      )}

      {(plan.warnings.length > 0 || (problems.length > 0 && source)) && (
        <div className="space-y-1">
          {[...problems.filter((p) => source || !p.startsWith("Pick the campaign")), ...plan.warnings].map((p) => (
            <p key={p} className="flex gap-1.5 text-xs text-warning" data-al-problem>
              <AlertIcon size={13} className="mt-0.5 shrink-0" />
              <span>{p}</span>
            </p>
          ))}
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger">
          <AlertIcon size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="pv-btn-primary disabled:opacity-50" disabled={!canStart} onClick={start} data-al-start>
          {starting ? <Spinner /> : <MoveIcon size={16} />}
          {queued ? "Add to queue" : "Add the leads"}
        </button>
        <span className="text-xs text-muted-foreground">
          {queued ? "A job is running; this one waits its turn. " : ""}It runs on the server — close the tab whenever you like. At the end, every campaign in the workspace that isn&apos;t running is launched (archived ones aside). The result is in Jobs below.
        </span>
      </div>
    </div>
  );
}
