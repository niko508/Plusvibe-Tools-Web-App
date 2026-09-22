"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Workspace } from "@/lib/plusvibe-types";
import {
  ApiClientError,
  abortStartOutreachJob,
  deleteStartOutreachJob,
  fetchSignaturePreset,
  listStartOutreachJobs,
  startStartOutreach,
} from "@/lib/api-client";
import { formatNumber } from "@/lib/format";
import { Spinner } from "@/components/ui";
import { AlertIcon, ChevronDownIcon, MoveIcon, RefreshIcon } from "@/components/icons";
import type { SheetConfig } from "@/lib/sheet-config";
import { DEFAULT_SHEET_TAB } from "@/lib/sheet-config";
import { DEFAULT_PLATFORM_TAGS, DEFAULT_TLD_TAGS } from "@/lib/tags/domain-tags";
import type { TagInput } from "@/lib/tags/bulk-tags";
import {
  ADDRESS_SLOTS,
  COMPANY_SLOTS,
  PHONE_SLOTS,
  SlotGroup,
  TITLE_SLOTS,
  padSlots,
  pickRandomRoles,
} from "../add-signatures/slots";
import {
  ACTIVE_STATUS,
  ACTIVE_TAG_NAME,
  countsInWords,
  domainsOf,
  parseOutreachSettings,
  planSignatures,
  previewSheetRows,
  previewDomainTags,
  signatureFieldsUsable,
  type MovingInbox,
  type OutreachSettingsInput,
} from "@/lib/start-outreach/plan";
import { CATEGORY_LABELS, describeSplit, splitByCategory } from "@/lib/start-outreach/categories";
import {
  DEFAULT_OUTREACH_SETTINGS,
  describeWeek,
  validateSettings,
  weekIsEmpty,
  type OutreachSettings,
} from "@/lib/start-outreach/week-settings";
import { fetchOutreachSettings } from "@/lib/api-client";
import { CategoryWeeks, WEEK_NOTE } from "./settings-panel";
import type { SheetWarmup } from "@/lib/start-outreach/readiness";
import type { StartOutreachJob } from "@/lib/jobs/start-outreach-types";
import { JobsPanel } from "./jobs-panel";

// Steps 2–6 of Start Outreach: where the inboxes go and what they get there,
// then the run itself. Everything here is a preview until the button is
// pressed; the server job does the work and is polled below.

const DEST_KEY = "pv_outreach_dest";
const OPTIONS_KEY = "pv_outreach_options";
const TAG_SETS_KEY = "pv_domain_tag_sets"; // shared with Bulk Actions
const POLL_MS = 2500;

interface Options {
  signatures: boolean;
  activeTag: boolean;
  domainTags: boolean;
  sheet: boolean;
}
const DEFAULT_OPTIONS: Options = { signatures: true, activeTag: true, domainTags: true, sheet: true };

function loadTagSets(): { tld: TagInput[]; platform: TagInput[] } {
  try {
    const raw = window.localStorage.getItem(TAG_SETS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { tld?: TagInput[]; platform?: TagInput[] };
      if (Array.isArray(parsed.tld) && Array.isArray(parsed.platform)) {
        return { tld: parsed.tld, platform: parsed.platform };
      }
    }
  } catch {
    // defaults below
  }
  return { tld: DEFAULT_TLD_TAGS, platform: DEFAULT_PLATFORM_TAGS };
}

export function OutreachSetup({
  source,
  workspaces,
  inboxes,
  sheetDates,
  sheetConfig,
  hasSheet,
  onRunQueued,
  onRunSettled,
  resetKey,
}: {
  source: { id: string; name: string } | null;
  workspaces: Workspace[];
  /** The ready inboxes on the ticked domains — what a run would move. */
  inboxes: MovingInbox[];
  sheetDates: Record<string, SheetWarmup>;
  sheetConfig: SheetConfig | null;
  hasSheet: boolean;
  /** A run has been accepted: these addresses are spoken for from now on. */
  onRunQueued: (emails: string[]) => void;
  /** That run has moved them, or stopped trying: what arrived, and what did not. */
  onRunSettled: (moved: string[], notMoved: string[]) => void;
  /** Bumped when the page starts a new batch: the destination is cleared. */
  resetKey: number;
}) {
  const [dest, setDest] = useState("");
  const [options, setOptions] = useState<Options>(DEFAULT_OPTIONS);
  // The saved settings, and this batch's copy of them. Editing here changes
  // only this run: the saved ones are changed in the Settings section, so a
  // one-off tweak can never quietly become the new default.
  const [saved, setSaved] = useState<OutreachSettings>(DEFAULT_OUTREACH_SETTINGS);
  const [weeks, setWeeks] = useState<OutreachSettings>(DEFAULT_OUTREACH_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [prefsLoaded, setPrefsLoaded] = useState(false);

  const [titles, setTitles] = useState<string[]>(Array(TITLE_SLOTS).fill(""));
  const [companies, setCompanies] = useState<string[]>(Array(COMPANY_SLOTS).fill(""));
  const [phones, setPhones] = useState<string[]>(Array(PHONE_SLOTS).fill(""));
  const [addresses, setAddresses] = useState<string[]>(Array(ADDRESS_SLOTS).fill(""));
  const [presetFrom, setPresetFrom] = useState<"destination" | "source" | null>(null);
  const [presetLoading, setPresetLoading] = useState(false);

  const [tagSets, setTagSets] = useState<{ tld: TagInput[]; platform: TagInput[] }>({ tld: [], platform: [] });

  const [armed, setArmed] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<StartOutreachJob[]>([]);
  const [highlightJobId, setHighlightJobId] = useState<string | null>(null);
  /** Runs started here since the page was opened — never folded away as old. */
  const [sessionIds, setSessionIds] = useState<Set<string>>(new Set());
  const pollLock = useRef(false);
  /** Runs started from this page: job id → the addresses sent. */
  const sentRef = useRef(new Map<string, string[]>());

  // --- Remembered choices --------------------------------------------------
  useEffect(() => {
    try {
      const d = window.localStorage.getItem(DEST_KEY);
      if (d) setDest(d);
      const o = window.localStorage.getItem(OPTIONS_KEY);
      if (o) setOptions({ ...DEFAULT_OPTIONS, ...(JSON.parse(o) as Partial<Options>) });
    } catch {
      // storage unavailable
    }
    setTagSets(loadTagSets());
    setTitles(pickRandomRoles(TITLE_SLOTS));
    setPrefsLoaded(true);
  }, []);
  // The saved settings are what this batch's boxes start on — placeholders to
  // adjust for this run, never written back by running it.
  const loadSaved = useCallback(async () => {
    try {
      const { settings: s } = await fetchOutreachSettings();
      setSaved(s);
      setWeeks(s);
    } catch {
      // the defaults stand, and the form says the numbers are its own
    } finally {
      setSettingsLoaded(true);
    }
  }, []);
  useEffect(() => {
    void loadSaved();
  }, [loadSaved]);
  // A new batch starts from the saved numbers again, whatever the last one used.
  useEffect(() => {
    if (settingsLoaded) setWeeks(saved);
  }, [resetKey, saved, settingsLoaded]);
  useEffect(() => {
    if (!prefsLoaded) return;
    try {
      if (dest) window.localStorage.setItem(DEST_KEY, dest);
      else window.localStorage.removeItem(DEST_KEY);
      window.localStorage.setItem(OPTIONS_KEY, JSON.stringify(options));
    } catch {
      // storage unavailable
    }
  }, [dest, options, prefsLoaded]);

  // The next batch most likely goes somewhere else, so the destination is
  // cleared rather than left pointing at the last client.
  useEffect(() => {
    if (resetKey === 0) return;
    setDest("");
    setArmed(false);
    setPresetFrom(null);
  }, [resetKey]);

  const destination = useMemo(() => workspaces.find((w) => w._id === dest) ?? null, [workspaces, dest]);
  const sameAsSource = !!source && !!destination && source.id === destination._id;

  // --- Signature details: the destination's saved ones, else the source's --
  useEffect(() => {
    if (!prefsLoaded) return;
    // One client's details must never carry over to the next: the fields
    // start clean for every destination and only its own saved ones fill in.
    setTitles(pickRandomRoles(TITLE_SLOTS));
    setCompanies(Array(COMPANY_SLOTS).fill(""));
    setPhones(Array(PHONE_SLOTS).fill(""));
    setAddresses(Array(ADDRESS_SLOTS).fill(""));
    setPresetFrom(null);
    if (!destination) return;
    let cancelled = false;
    setPresetLoading(true);
    void (async () => {
      const apply = (p: { titles: string[]; companies: string[]; phones: string[]; addresses: string[] }) => {
        if (p.titles.length) setTitles(padSlots(p.titles, TITLE_SLOTS));
        if (p.companies.length) setCompanies(padSlots(p.companies, COMPANY_SLOTS));
        if (p.phones.length) setPhones(padSlots(p.phones, PHONE_SLOTS));
        if (p.addresses.length) setAddresses(padSlots(p.addresses, ADDRESS_SLOTS));
      };
      try {
        const { preset } = await fetchSignaturePreset(destination._id);
        if (cancelled) return;
        if (preset) {
          apply(preset);
          setPresetFrom("destination");
          return;
        }
        if (source) {
          const { preset: fromSource } = await fetchSignaturePreset(source.id);
          if (cancelled) return;
          if (fromSource) {
            apply(fromSource);
            setPresetFrom("source");
          }
        }
      } catch {
        // remembering is a convenience; typing them in still works
      } finally {
        if (!cancelled) setPresetLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [prefsLoaded, destination, source]);

  // --- Previews ------------------------------------------------------------
  const fields = useMemo(() => ({ titles, companies, phones, addresses }), [titles, companies, phones, addresses]);
  const signaturesUsable = signatureFieldsUsable(fields);
  const sigPlan = useMemo(() => planSignatures(inboxes), [inboxes]);
  // What this batch is made of. Only the categories actually present get a
  // form: a run with no Azure 50 domains has no reason to show its numbers.
  const split = useMemo(() => splitByCategory(inboxes), [inboxes]);
  const present = useMemo(() => split.groups.map((g) => g.category), [split]);
  const weekProblems = useMemo(
    () => validateSettings(weeks).filter((p) => present.some((c) => p.startsWith(CATEGORY_LABELS[c]))),
    [weeks, present]
  );
  const domains = useMemo(() => domainsOf(inboxes), [inboxes]);
  const hosts = useMemo(() => {
    const out: Record<string, string | undefined> = {};
    for (const [d, v] of Object.entries(sheetDates)) out[d] = v.host;
    return out;
  }, [sheetDates]);
  const tagPreview = useMemo(
    () => previewDomainTags(inboxes, hosts, tagSets.tld, tagSets.platform),
    [inboxes, hosts, tagSets]
  );
  const sheetPreview = useMemo(
    () => previewSheetRows(domains, sheetDates),
    [domains, sheetDates, destination]
  );

  // --- Jobs ----------------------------------------------------------------
  const refreshJobs = useCallback(async () => {
    if (pollLock.current) return;
    pollLock.current = true;
    try {
      const res = await listStartOutreachJobs();
      setJobs(res.jobs ?? []);
    } catch {
      // keep what we have
    } finally {
      pollLock.current = false;
    }
  }, []);
  useEffect(() => {
    void refreshJobs();
  }, [refreshJobs]);
  const live = jobs.filter((j) => j.status === "running" || j.status === "queued");
  const anyLive = live.length > 0;
  // A run reports back once it has checked the inboxes arrived: everything
  // after that happens in the destination, so what moved is settled. The page
  // took them off the list when the run was accepted; this says which of them
  // are gone for good and which are still in the warming workspace.
  useEffect(() => {
    for (const job of jobs) {
      const sent = sentRef.current.get(job.id);
      if (!sent) continue;
      const verify = job.steps.find((s) => s.key === "verify");
      const moveSettled =
        !!verify && verify.state !== "pending" && verify.state !== "running";
      const stopped = job.status !== "running" && job.status !== "queued";
      if (!moveSettled && !stopped) continue;
      sentRef.current.delete(job.id);
      // Stopped before the check ran: which inboxes moved is unknown, and
      // "not moved" is empty because nothing looked. Treating them as moved
      // would lose inboxes that are still sitting in the warming workspace,
      // so they all come back and the next fetch settles it.
      if (!moveSettled) {
        onRunSettled([], sent);
        continue;
      }
      const notMoved = new Set(job.notMoved.map((e) => e.trim().toLowerCase()));
      onRunSettled(
        sent.filter((e) => !notMoved.has(e.trim().toLowerCase())),
        sent.filter((e) => notMoved.has(e.trim().toLowerCase()))
      );
    }
  }, [jobs, onRunSettled]);
  useEffect(() => {
    if (!anyLive) return;
    const t = setInterval(() => void refreshJobs(), POLL_MS);
    return () => clearInterval(t);
  }, [anyLive, refreshJobs]);
  useEffect(() => {
    if (!highlightJobId) return;
    const t = setTimeout(() => setHighlightJobId(null), 4000);
    return () => clearTimeout(t);
  }, [highlightJobId]);

  const problems: string[] = [];
  if (!source) problems.push("Fetch the warming workspace first.");
  if (inboxes.length === 0) problems.push("Tick at least one ready domain above.");
  if (!destination) problems.push("Pick the destination workspace.");
  if (sameAsSource) problems.push("The destination has to be a different workspace.");
  if (options.signatures && !signaturesUsable) problems.push("Signatures need a job title and a company name, or untick them.");
  problems.push(...weekProblems);
  if (inboxes.length > 0 && present.length === 0) {
    problems.push("None of these domains is on Google or Microsoft, so there are no settings to apply.");
  }
  // A run already going is no reason to wait: this one queues behind it and
  // starts itself.
  const canRun = problems.length === 0 && armed && !starting;

  async function run() {
    if (!source || !destination || problems.length > 0) return;
    setStarting(true);
    setError(null);
    try {
      const { jobId } = await startStartOutreach({
        sourceWorkspaceId: source.id,
        sourceWorkspaceName: source.name,
        destWorkspaceId: destination._id,
        destWorkspaceName: destination.name,
        inboxes,
        // Only the categories in this batch: an Azure 50 form nobody filled in
        // must not reach a run that has no Azure 50 domains.
        weeks: Object.fromEntries(present.map((c) => [c, weeks[c]])),
        signatures: options.signatures ? fields : null,
        activeTag: options.activeTag ? ACTIVE_TAG_NAME : null,
        domainTags: options.domainTags ? tagSets : null,
        sheet: {
          url: sheetConfig?.url,
          tab: sheetConfig?.tab || DEFAULT_SHEET_TAB,
          updateSheet: options.sheet,
        },
      });
      const sent = inboxes.map((i) => i.email);
      sentRef.current.set(jobId, sent);
      setSessionIds((prev) => new Set(prev).add(jobId));
      setHighlightJobId(jobId);
      setArmed(false);
      // The batch is the run's now, whether it starts this second or waits
      // behind three others. The page lets go of it here so the next one can
      // be put together without waiting for anything.
      onRunQueued(sent);
      await refreshJobs();
    } catch (err) {
      setError(err instanceof ApiClientError || err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setStarting(false);
    }
  }

  const opt = (key: keyof Options) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setOptions((o) => ({ ...o, [key]: e.target.checked }));

  return (
    <div className="space-y-5" data-setup>
      {/* Step 2 · Destination */}
      <div className="pv-card space-y-3 p-4 sm:p-5">
        <h2 className="text-sm font-semibold">Step 2 · Destination workspace</h2>
        <div className="relative max-w-md">
          <select
            className="pv-input appearance-none pr-9"
            value={dest}
            aria-label="Destination workspace"
            onChange={(e) => setDest(e.target.value)}
          >
            <option value="">Pick where the inboxes go</option>
            {workspaces
              .filter((w) => w._id !== source?.id)
              .map((w) => (
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

      {/* Step 3 · Signatures */}
      <div className="pv-card space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Step 3 · Signatures</h2>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="accent-accent"
              checked={options.signatures}
              onChange={opt("signatures")}
              aria-label="Set signatures"
            />
            Set signatures on the moved inboxes
          </label>
        </div>
        {options.signatures && (
          <>
            <SlotGroup
              label="Job titles / roles"
              hint="At least one required"
              values={titles}
              onChange={setTitles}
              placeholder="Account Executive"
              headerAction={
                <button type="button" className="pv-chip" onClick={() => setTitles(pickRandomRoles(TITLE_SLOTS))}>
                  <RefreshIcon size={13} />
                  Shuffle
                </button>
              }
            />
            <SlotGroup
              label="Company names"
              hint="At least one required"
              values={companies}
              onChange={setCompanies}
              placeholder="The Media Manager"
            />
            <SlotGroup label="Phone numbers" values={phones} onChange={setPhones} placeholder="(507) 218-8731" />
            <SlotGroup label="Addresses" values={addresses} onChange={setAddresses} placeholder="Rochester, MN 55901" />
            <p className="text-xs text-muted-foreground" data-signature-note>
              {presetLoading ? (
                <span className="flex items-center gap-2">
                  <Spinner size={12} /> Checking for saved details…
                </span>
              ) : presetFrom === "destination" ? (
                `Filled in from the details saved for ${destination?.name}.`
              ) : presetFrom === "source" ? (
                `Filled in from the details saved for ${source?.name}; they are saved for ${destination?.name} when the run starts.`
              ) : destination ? (
                `Nothing saved for ${destination?.name} yet; these are saved for it when the run starts.`
              ) : (
                "Pick the destination to load its saved details."
              )}
              {inboxes.length > 0 &&
                ` ${formatNumber(sigPlan.withName)} of ${formatNumber(inboxes.length)} inboxes carry a first name` +
                  (sigPlan.noName > 0 ? `; ${formatNumber(sigPlan.noName)} without one get no signature.` : ".")}
            </p>
          </>
        )}
      </div>

      {/* Step 4 · Settings */}
      <div className="pv-card space-y-4 p-4 sm:p-5" data-step-settings>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Step 4 · Settings</h2>
          <span className="text-xs text-muted-foreground">
            {inboxes.length === 0
              ? "Tick some domains to see what they are."
              : `This batch: ${describeSplit(split)}`}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          {WEEK_NOTE} These start on the saved settings; changing them here changes only this batch.
        </p>

        {!settingsLoaded ? (
          <div className="h-24 animate-pulse rounded-xl bg-muted" />
        ) : present.length === 0 ? (
          <p className="rounded-xl border border-border px-3 py-6 text-center text-sm text-muted-foreground">
            {inboxes.length === 0
              ? "Nothing selected yet."
              : "None of these domains is on Google or Microsoft, so there are no settings to apply."}
          </p>
        ) : (
          present.map((c) => {
            const n = split.groups.find((g) => g.category === c)?.inboxes.length ?? 0;
            return (
              <CategoryWeeks
                key={c}
                category={c}
                value={weeks[c]}
                idPrefix="batch"
                onChange={(next) => setWeeks((w) => ({ ...w, [c]: next }))}
                headerRight={
                  <span className="text-xs text-muted-foreground">
                    {formatNumber(n)} inbox{n === 1 ? "" : "es"} in this batch
                    {weekIsEmpty(weeks[c].week2) && (
                      <span className="text-warning"> · no week 2 switch</span>
                    )}
                  </span>
                }
              />
            );
          })
        )}

        {split.uncategorized.length > 0 && (
          <p className="flex gap-1.5 text-xs text-warning" data-uncategorized>
            <AlertIcon size={13} className="mt-0.5 shrink-0" />
            <span>
              {formatNumber(split.uncategorized.length)} inbox
              {split.uncategorized.length === 1 ? "" : "es"} on domains that are on neither Google nor Microsoft. They
              are still moved, but get no settings and no week 2 switch.
            </span>
          </p>
        )}

        {weekProblems.map((p) => (
          <p key={p} className="text-xs text-danger">
            {p}
          </p>
        ))}
      </div>

      {/* Step 5 · Tags */}
      <div className="pv-card space-y-3 p-4 sm:p-5">
        <h2 className="text-sm font-semibold">Step 5 · Tags</h2>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="accent-accent"
            checked={options.activeTag}
            onChange={opt("activeTag")}
            aria-label="Add active tag"
          />
          <span>
            Add the <span className="pv-chip">{ACTIVE_TAG_NAME}</span> tag to every moved inbox
          </span>
        </label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="accent-accent"
            checked={options.domainTags}
            onChange={opt("domainTags")}
            aria-label="Add domain tags"
          />
          Add the TLD tag and the platform tag from the sheet&apos;s Domain Host
        </label>
        {options.domainTags && inboxes.length > 0 && (
          <p className="text-xs text-muted-foreground" data-tag-preview>
            TLD: {countsInWords(tagPreview.tldCounts) || "none"}
            {tagPreview.tldNoTag > 0 ? ` · ${tagPreview.tldNoTag} domain${tagPreview.tldNoTag === 1 ? "" : "s"} with no tag for the TLD` : ""}
            {" · "}Platform: {countsInWords(tagPreview.platformCounts) || "none"}
            {tagPreview.notInSheet > 0 ? ` · ${tagPreview.notInSheet} domain${tagPreview.notInSheet === 1 ? "" : "s"} not in the sheet` : ""}
            {tagPreview.hostNoTag > 0 ? ` · ${tagPreview.hostNoTag} with a host that has no tag` : ""}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Tag sets: {tagSets.tld.map((t) => t.name).join(", ")} · {tagSets.platform.map((t) => t.name).join(", ")}{" "}
          <a href="/tools/bulk-actions" className="underline">
            edit in Bulk Actions
          </a>
        </p>
      </div>

      {/* Step 6 · Sheet */}
      <div className="pv-card space-y-3 p-4 sm:p-5">
        <h2 className="text-sm font-semibold">Step 6 · Sheet</h2>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="accent-accent"
            checked={options.sheet}
            onChange={opt("sheet")}
            aria-label="Update the Domains tab"
          />
          <span>
            In the Domains tab, set Status to{" "}
            <span className="font-medium text-foreground">{ACTIVE_STATUS}</span> and clear Warmup Started / Warmup Days
          </span>
        </label>
        {options.sheet && inboxes.length > 0 && (
          <p className="text-xs text-muted-foreground" data-sheet-preview>
            {formatNumber(sheetPreview.inSheet.length)} of {formatNumber(domains.length)} domains are in the sheet
            {sheetPreview.withWarmup > 0 ? ` · ${sheetPreview.withWarmup} with warmup dates to clear` : ""}
            {sheetPreview.notInSheet.length > 0
              ? ` · not in the sheet: ${sheetPreview.notInSheet.slice(0, 5).join(", ")}${sheetPreview.notInSheet.length > 5 ? ", …" : ""}`
              : ""}
            {!hasSheet ? " · writes go to the server's Email Infra sheet" : ""}
          </p>
        )}
      </div>

      {/* Run */}
      <div className={`pv-card space-y-3 p-4 sm:p-5 ${canRun ? "border-accent/40" : ""}`} data-run-card>
        <h2 className="text-sm font-semibold">
          {inboxes.length > 0 && destination
            ? `Move ${formatNumber(inboxes.length)} inbox${inboxes.length === 1 ? "" : "es"} on ${formatNumber(domains.length)} domain${domains.length === 1 ? "" : "s"} to ${destination.name}`
            : "Move"}
        </h2>
        <p className="text-xs text-muted-foreground">
          Then in {destination?.name ?? "the destination"}:{" "}
          {[
            `week 1 settings (${present.length} kind${present.length === 1 ? "" : "s"})`,
            options.signatures ? "signatures" : null,
            options.activeTag ? `"${ACTIVE_TAG_NAME}" tag` : null,
            options.domainTags ? "TLD + platform tags" : null,
            options.sheet ? "sheet (Status, warmup cleared)" : null,
          ]
            .filter(Boolean)
            .join(" · ")}
          .
        </p>
        {problems.length > 0 && (
          <ul className="space-y-0.5 text-xs text-warning" data-run-problems>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            <AlertIcon size={14} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="accent-accent"
              checked={armed}
              onChange={(e) => setArmed(e.target.checked)}
              aria-label="Confirm move"
              disabled={problems.length > 0}
            />
            I have checked the destination and the settings
          </label>
          <button
            type="button"
            className="pv-btn-primary disabled:opacity-50"
            disabled={!canRun}
            onClick={() => void run()}
            data-run
          >
            {starting ? <Spinner /> : <MoveIcon size={16} />}
            {starting ? "Starting…" : anyLive ? "Queue behind the run going" : "Move and set up"}
          </button>
          {anyLive && !starting && (
            <span className="text-xs text-muted-foreground" data-queue-note>
              {formatNumber(live.length)} run{live.length === 1 ? "" : "s"} still going — this one waits its turn and
              starts on its own.
            </span>
          )}
        </div>
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-semibold">Runs</h2>
        <JobsPanel
          jobs={jobs}
          highlightJobId={highlightJobId}
          sessionIds={sessionIds}
          onAbort={async (id) => {
            await abortStartOutreachJob(id).catch(() => undefined);
            await refreshJobs();
          }}
          onRemove={async (id) => {
            await deleteStartOutreachJob(id).catch(() => undefined);
            await refreshJobs();
          }}
        />
      </div>
    </div>
  );
}
