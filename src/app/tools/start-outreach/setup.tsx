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
  EMPTY_OUTREACH_SETTINGS,
  OUTREACH_FIELDS,
  FIXED_ROWS,
  countsInWords,
  domainsOf,
  parseOutreachSettings,
  planSignatures,
  previewClientColumn,
  previewDomainTags,
  signatureFieldsUsable,
  type MovingInbox,
  type OutreachSettingsInput,
} from "@/lib/start-outreach/plan";
import type { SheetWarmup } from "@/lib/start-outreach/readiness";
import type { StartOutreachJob } from "@/lib/jobs/start-outreach-types";
import { JobsPanel } from "./jobs-panel";

// Steps 2–6 of Start Outreach: where the inboxes go and what they get there,
// then the run itself. Everything here is a preview until the button is
// pressed; the server job does the work and is polled below.

const DEST_KEY = "pv_outreach_dest";
const SETTINGS_KEY = "pv_outreach_settings";
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
}: {
  source: { id: string; name: string } | null;
  workspaces: Workspace[];
  /** The ready inboxes on the ticked domains — what a run would move. */
  inboxes: MovingInbox[];
  sheetDates: Record<string, SheetWarmup>;
  sheetConfig: SheetConfig | null;
  hasSheet: boolean;
}) {
  const [dest, setDest] = useState("");
  const [options, setOptions] = useState<Options>(DEFAULT_OPTIONS);
  const [settings, setSettings] = useState<OutreachSettingsInput>(EMPTY_OUTREACH_SETTINGS);
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
  const pollLock = useRef(false);

  // --- Remembered choices --------------------------------------------------
  useEffect(() => {
    try {
      const d = window.localStorage.getItem(DEST_KEY);
      if (d) setDest(d);
      const s = window.localStorage.getItem(SETTINGS_KEY);
      if (s) setSettings({ ...EMPTY_OUTREACH_SETTINGS, ...(JSON.parse(s) as Partial<OutreachSettingsInput>) });
      const o = window.localStorage.getItem(OPTIONS_KEY);
      if (o) setOptions({ ...DEFAULT_OPTIONS, ...(JSON.parse(o) as Partial<Options>) });
    } catch {
      // storage unavailable
    }
    setTagSets(loadTagSets());
    setTitles(pickRandomRoles(TITLE_SLOTS));
    setPrefsLoaded(true);
  }, []);
  useEffect(() => {
    if (!prefsLoaded) return;
    try {
      if (dest) window.localStorage.setItem(DEST_KEY, dest);
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      window.localStorage.setItem(OPTIONS_KEY, JSON.stringify(options));
    } catch {
      // storage unavailable
    }
  }, [dest, settings, options, prefsLoaded]);

  const destination = useMemo(() => workspaces.find((w) => w._id === dest) ?? null, [workspaces, dest]);
  const sameAsSource = !!source && !!destination && source.id === destination._id;

  // --- Signature details: the destination's saved ones, else the source's --
  useEffect(() => {
    if (!prefsLoaded || !destination) return;
    let cancelled = false;
    setPresetLoading(true);
    setPresetFrom(null);
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
  const parsed = useMemo(() => parseOutreachSettings(settings), [settings]);
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
  const clientPreview = useMemo(
    () => previewClientColumn(domains, sheetDates, destination?.name ?? ""),
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
  const anyRunning = jobs.some((j) => j.status === "running");
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => void refreshJobs(), POLL_MS);
    return () => clearInterval(t);
  }, [anyRunning, refreshJobs]);
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
  for (const p of Object.values(parsed.problems)) if (p) problems.push(p);
  const canRun = problems.length === 0 && armed && !starting && !anyRunning;

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
        settings,
        signatures: options.signatures ? fields : null,
        activeTag: options.activeTag ? ACTIVE_TAG_NAME : null,
        domainTags: options.domainTags ? tagSets : null,
        sheet: {
          url: sheetConfig?.url,
          tab: sheetConfig?.tab || DEFAULT_SHEET_TAB,
          updateClient: options.sheet,
        },
      });
      setHighlightJobId(jobId);
      setArmed(false);
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
      <div className="pv-card space-y-4 p-4 sm:p-5">
        <h2 className="text-sm font-semibold">Step 4 · Settings</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {OUTREACH_FIELDS.map((f) => (
            <div key={f.key}>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                {f.label}{" "}
                <span className="font-mono text-[10px] text-muted-foreground/70">{f.apiField}</span>
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={f.min}
                  max={f.max}
                  step={f.integer ? 1 : 0.1}
                  className={`pv-input w-full text-right tabular-nums ${parsed.problems[f.key] ? "border-danger" : ""}`}
                  value={settings[f.key]}
                  placeholder="leave as is"
                  aria-label={f.label}
                  onChange={(e) => setSettings((s) => ({ ...s, [f.key]: e.target.value }))}
                />
                <span className="w-14 shrink-0 text-xs text-muted-foreground">{f.unit}</span>
              </div>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-fixed-settings>
          {FIXED_ROWS.map((r) => (
            <span key={r.key} className="pv-chip" title={r.apiField}>
              {r.label} <span className="ml-1 font-medium">{r.value}</span>
            </span>
          ))}
          <span>Blank fields are left as they are.</span>
        </div>
        {Object.values(parsed.problems).map((p) => (
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
            aria-label="Update client column"
          />
          <span>
            In the Domains tab, set Client to{" "}
            <span className="font-medium text-foreground">{destination?.name ?? "the destination"}</span>, Status to{" "}
            <span className="font-medium text-foreground">{ACTIVE_STATUS}</span>, and clear Warmup Started / Warmup Days
          </span>
        </label>
        {options.sheet && inboxes.length > 0 && (
          <p className="text-xs text-muted-foreground" data-client-preview>
            {formatNumber(clientPreview.inSheet.length)} of {formatNumber(domains.length)} domains are in the sheet
            {clientPreview.alreadySet > 0 ? ` (${clientPreview.alreadySet} already say ${destination?.name})` : ""}
            {clientPreview.withWarmup > 0 ? ` · ${clientPreview.withWarmup} with warmup dates to clear` : ""}
            {clientPreview.notInSheet.length > 0
              ? ` · not in the sheet: ${clientPreview.notInSheet.slice(0, 5).join(", ")}${clientPreview.notInSheet.length > 5 ? ", …" : ""}`
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
            `settings (${parsed.summary.length})`,
            options.signatures ? "signatures" : null,
            options.activeTag ? `"${ACTIVE_TAG_NAME}" tag` : null,
            options.domainTags ? "TLD + platform tags" : null,
            options.sheet ? "sheet (Client, Status, warmup cleared)" : null,
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
            {starting ? "Starting…" : anyRunning ? "A run is going" : "Move and set up"}
          </button>
        </div>
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-semibold">Runs</h2>
        <JobsPanel
          jobs={jobs}
          highlightJobId={highlightJobId}
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
