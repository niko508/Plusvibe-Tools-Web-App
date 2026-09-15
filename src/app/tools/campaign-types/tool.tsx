"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Workspace, CampaignSummary } from "@/lib/plusvibe-types";
import type {
  CampaignTypesJob,
  CampaignTypesMode,
} from "@/lib/jobs/campaign-types-types";
import { CREATED_ROLES } from "@/lib/jobs/campaign-types-types";
import {
  fetchWorkspaces,
  fetchCampaigns,
  startCampaignTypes,
  listCampaignTypesJobs,
  abortCampaignTypes,
  deleteCampaignTypesJob,
  fetchCampaignTypesSettings,
  saveCampaignTypesSettings,
  ApiClientError,
} from "@/lib/api-client";
import {
  DEFAULT_SETTINGS,
  DOMINANT_OPTIONS,
  describeDominant,
  describeLimits,
  parseLimit,
  type CampaignTypesSettings,
  type Dominant,
} from "@/lib/campaign-types/settings";
import { useApiKey } from "@/lib/use-api-key";
import { formatNumber } from "@/lib/format";
import { ConnectPrompt } from "@/components/connect-prompt";
import { Spinner, EmptyState } from "@/components/ui";
import {
  LayersIcon,
  AlertIcon,
  ChevronDownIcon,
  CheckIcon,
  MoveIcon,
  SettingsIcon,
} from "@/components/icons";
import { deriveNames } from "@/lib/campaign-types/names";
import {
  isArchived,
  matchMoveTargets,
  normalizeName,
} from "@/lib/campaign-types/match";
import { JobCard } from "./job-card";

const POLL_MS = 2000;
const ROLE_LABELS = {
  blue: "Microsoft leads",
  optOut: "Opt-out copy on step 1",
  blueOptOut: "Microsoft leads + opt-out copy",
  signature: "Signs off with the signature",
  blueSignature: "Microsoft leads + signature sign-off",
} as const;

export function CampaignTypesTool() {
  const { hasKey, ready } = useApiKey();

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [workspacesLoading, setWorkspacesLoading] = useState(false);

  const [campaigns, setCampaigns] = useState<CampaignSummary[] | null>(null);
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [sourceId, setSourceId] = useState<string>("");
  const [activate, setActivate] = useState(true);
  const [mode, setMode] = useState<CampaignTypesMode>("create");
  // The Settings tab sits beside the two modes but starts no job; the mode
  // it was opened from is kept, so closing it goes back to where you were.
  const [showSettings, setShowSettings] = useState(false);

  // --- Settings: read once, saved on request, kept as typed in between ------
  const [settings, setSettings] = useState<CampaignTypesSettings>(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [draftDominant, setDraftDominant] = useState<Dominant>(DEFAULT_SETTINGS.dominant);
  const [draftGoogle, setDraftGoogle] = useState("");
  const [draftMicrosoft, setDraftMicrosoft] = useState("");
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsNote, setSettingsNote] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const applyToDraft = useCallback((s: CampaignTypesSettings) => {
    setDraftDominant(s.dominant);
    setDraftGoogle(s.googleDailyLimit === null ? "" : String(s.googleDailyLimit));
    setDraftMicrosoft(s.microsoftDailyLimit === null ? "" : String(s.microsoftDailyLimit));
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const { settings: s } = await fetchCampaignTypesSettings();
      setSettings(s);
      applyToDraft(s);
      setSettingsLoaded(true);
    } catch (err) {
      setSettingsError(errMessage(err));
    }
  }, [applyToDraft]);

  const googleProblem = parseLimit(draftGoogle, "Google daily limit").error ?? null;
  const microsoftProblem = parseLimit(draftMicrosoft, "Microsoft daily limit").error ?? null;
  const draftDirty =
    draftDominant !== settings.dominant ||
    (parseLimit(draftGoogle, "").value ?? null) !== settings.googleDailyLimit ||
    (parseLimit(draftMicrosoft, "").value ?? null) !== settings.microsoftDailyLimit;
  const canSave = settingsLoaded && draftDirty && !googleProblem && !microsoftProblem && !savingSettings;

  async function handleSaveSettings() {
    if (!canSave) return;
    setSavingSettings(true);
    setSettingsError(null);
    setSettingsNote(null);
    try {
      const { settings: s } = await saveCampaignTypesSettings({
        dominant: draftDominant,
        googleDailyLimit: parseLimit(draftGoogle, "").value,
        microsoftDailyLimit: parseLimit(draftMicrosoft, "").value,
      });
      setSettings(s);
      applyToDraft(s);
      setSettingsNote("Saved — every run from now on uses these.");
      setTimeout(() => setSettingsNote(null), 5000);
    } catch (err) {
      setSettingsError(errMessage(err));
    } finally {
      setSavingSettings(false);
    }
  }

  const [jobs, setJobs] = useState<CampaignTypesJob[]>([]);
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
    if (ready && hasKey) {
      void loadWorkspaces();
      void refreshJobs();
      void loadSettings();
    }
  }, [ready, hasKey, loadWorkspaces, refreshJobs, loadSettings]);

  // Queued jobs need polling too — nothing else tells the page when one of them
  // reaches the front and starts.
  const anyRunning = jobs.some(
    (j) => j.status === "running" || j.status === "queued"
  );
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => void refreshJobs(), POLL_MS);
    return () => clearInterval(t);
  }, [anyRunning, refreshJobs]);

  const loadCampaigns = useCallback(async (wsId: string) => {
    setCampaignsLoading(true);
    setCampaigns(null);
    setSourceId("");
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
  // Sub-sequences are separate campaign records and are never the source.
  const parents = useMemo(
    () => (campaigns ?? []).filter((c) => c.campaignType !== "subseq"),
    [campaigns]
  );
  const source = parents.find((c) => c.id === sourceId) ?? null;
  const names = source ? deriveNames(source.name) : null;

  // Names already taken in this workspace. The job adopts an existing campaign
  // rather than making a second one under the same name, so a re-run after an
  // interruption is safe — this shows that before it happens.
  //
  // Archived ones are skipped, matching what the run does: their name is free
  // again, so the preview must not promise a reuse the run won't make.
  const existing = useMemo(() => {
    const map = new Map<string, CampaignSummary>();
    for (const c of parents) {
      if (isArchived(c)) continue;
      const key = normalizeName(c.name);
      if (!map.has(key)) map.set(key, c);
    }
    return map;
  }, [parents]);

  // A name whose only holder is archived: the run makes a fresh campaign under
  // it, which is worth saying plainly rather than showing nothing.
  const archivedNames = useMemo(() => {
    const set = new Set<string>();
    for (const c of parents) if (isArchived(c)) set.add(normalizeName(c.name));
    for (const key of existing.keys()) set.delete(key);
    return set;
  }, [parents, existing]);

  const rows = names
    ? CREATED_ROLES.map((role) => ({
        role,
        name: names[role],
        reused: existing.get(normalizeName(names[role])) ?? null,
        replacesArchived: archivedNames.has(normalizeName(names[role])),
      }))
    : [];
  const reusedCount = rows.filter((r) => r.reused).length;
  const archivedCount = rows.filter((r) => r.replacesArchived).length;

  // Move Leads: the five campaigns the leads would go into, found by name the
  // same way the run finds them — so what is shown here is what will happen.
  // Archived campaigns are left out: they cannot take a lead.
  const moveMatch = useMemo(
    () => (source ? matchMoveTargets(source.name, parents, source.id) : null),
    [source, parents]
  );
  const missingCount = moveMatch
    ? moveMatch.matches.filter((m) => !m.match).length
    : 0;
  const foundCount = moveMatch ? moveMatch.matches.length - missingCount : 0;
  // Which 🔵 campaigns are there decides where the Microsoft leads can go: with
  // none of them, those leads have nowhere to belong and stay in the source.
  const blueFound = moveMatch
    ? moveMatch.matches.some(
        (m) =>
          m.match &&
          (m.role === "blue" || m.role === "blueOptOut" || m.role === "blueSignature")
      )
    : false;

  const activeJob = jobs.find((j) => j.status === "running") ?? null;
  const queuedCount = jobs.filter((j) => j.status === "queued").length;
  // Already-pending work no longer blocks Start — it queues behind it. The one
  // thing that is still refused is the same source campaign twice over, which
  // the server rejects and the button disables here so it isn't even offered.
  const alreadyPending = jobs.some(
    (j) =>
      (j.status === "running" || j.status === "queued") &&
      j.sourceCampaignId === sourceId
  );
  const canStart =
    !!source &&
    !showSettings &&
    !alreadyPending &&
    !starting &&
    // A move needs somewhere to move to, but not all five: the campaigns that
    // are there take the share of the ones that are not.
    (mode === "create" || foundCount > 0);

  // --- Actions -------------------------------------------------------------
  async function handleStart() {
    if (!source || !names || startLock.current) return;
    startLock.current = true;
    setStarting(true);
    setError(null);
    try {
      await startCampaignTypes({
        mode,
        workspaceId: workspaceId!,
        workspaceName: workspaces.find((w) => w._id === workspaceId)?.name ?? "",
        sourceCampaignId: source.id,
        sourceCampaignName: source.name,
        names,
        activate: mode === "create" && activate,
      });
      setToast(
        activeJob || queuedCount > 0
          ? "Added to the queue — it starts when the ones ahead finish"
          : "Job started — you can close this tab"
      );
      setTimeout(() => setToast(null), 5000);
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

  return (
    <div className="space-y-5">
      <div className="pv-card space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="What to run">
          {(
            [
              ["create", "Create all types"],
              ["move", "Move leads"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={!showSettings && mode === value}
              className={`pv-chip ${!showSettings && mode === value ? "pv-chip-active" : "hover:text-foreground"}`}
              onClick={() => {
                setMode(value);
                setShowSettings(false);
              }}
              data-mode={value}
            >
              {label}
            </button>
          ))}
          {/* Warning-toned so it stands apart from the two modes it sits beside. */}
          <button
            type="button"
            role="tab"
            aria-selected={showSettings}
            className={`pv-chip border-warning/50 text-warning hover:bg-warning/10 ${
              showSettings ? "bg-warning/15" : ""
            }`}
            onClick={() => setShowSettings(true)}
            data-mode="settings"
          >
            <SettingsIcon size={13} />
            Settings
          </button>
          <span className="self-center text-xs text-muted-foreground">
            {showSettings
              ? "Saved for every run until you change them."
              : mode === "create"
                ? "Builds the five campaigns, then splits the leads into them."
                : "The five campaigns already exist: this only splits the source's not-contacted leads into them."}
          </span>
        </div>

        {showSettings && (
          <div className="space-y-4" data-settings>
            <div>
              <div className="mb-1.5 text-xs font-medium text-muted-foreground">Dominant targeting</div>
              <div className="flex flex-wrap items-center gap-1.5 text-xs" role="radiogroup" aria-label="Dominant targeting">
                {DOMINANT_OPTIONS.map((o) => (
                  <button
                    key={o.key}
                    type="button"
                    role="radio"
                    aria-checked={draftDominant === o.key}
                    className={`pv-chip ${draftDominant === o.key ? "pv-chip-active" : "hover:text-foreground"}`}
                    onClick={() => setDraftDominant(o.key)}
                    title={o.hint}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                Which side gets the leads that are neither Microsoft nor Google. {describeDominant(draftDominant)}
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground" htmlFor="ct-google-limit">
                  Google daily limit
                </label>
                <input
                  id="ct-google-limit"
                  type="number"
                  className="pv-input"
                  min={0}
                  step={1}
                  placeholder="As duplicated"
                  value={draftGoogle}
                  onChange={(e) => setDraftGoogle(e.target.value)}
                  aria-label="Google daily limit"
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Maximum emails per day, set on each plain copy the run creates.
                  {googleProblem && <span className="block text-warning">{googleProblem}</span>}
                </p>
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground" htmlFor="ct-microsoft-limit">
                  Microsoft daily limit
                </label>
                <input
                  id="ct-microsoft-limit"
                  type="number"
                  className="pv-input"
                  min={0}
                  step={1}
                  placeholder="As duplicated"
                  value={draftMicrosoft}
                  onChange={(e) => setDraftMicrosoft(e.target.value)}
                  aria-label="Microsoft daily limit"
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Maximum emails per day, set on each 🔵 copy the run creates.
                  {microsoftProblem && <span className="block text-warning">{microsoftProblem}</span>}
                </p>
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              A blank limit leaves the copy on whatever it was duplicated with. The source campaign itself is never
              changed, and Move leads runs set no limits — the campaigns they move into were created, and limited,
              by an earlier run.
            </p>

            {settingsError && (
              <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger">
                <AlertIcon size={16} className="mt-0.5 shrink-0" />
                <span>{settingsError}</span>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="pv-btn-primary disabled:opacity-50"
                disabled={!canSave}
                onClick={handleSaveSettings}
                data-save-settings
              >
                {savingSettings ? <Spinner /> : <CheckIcon size={16} />}
                Save settings
              </button>
              {settingsNote ? (
                <span className="text-xs text-success">{settingsNote}</span>
              ) : !settingsLoaded ? (
                <span className="text-xs text-muted-foreground">Reading the saved settings…</span>
              ) : draftDirty ? (
                <span className="text-xs text-muted-foreground">Not saved yet.</span>
              ) : null}
            </div>
          </div>
        )}

        <div className={`grid gap-4 sm:grid-cols-2 ${showSettings ? "hidden" : ""}`}>
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
              Original campaign
            </label>
            <div className="relative">
              <select
                className="pv-input appearance-none pr-9"
                value={sourceId}
                disabled={campaignsLoading || parents.length === 0}
                onChange={(e) => setSourceId(e.target.value)}
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

        {!showSettings && mode === "move" && source && moveMatch && (
          <div className="rounded-xl border border-border p-3 sm:p-4" data-move-preview>
            <h3 className="mb-1 text-sm font-medium">
              {missingCount === 0
                ? "Leads go to these five campaigns"
                : foundCount === 0
                  ? "None of these five campaigns are in this workspace"
                  : `Leads go to the ${formatNumber(foundCount)} campaigns that are there`}
            </h3>
            <p className="mb-3 text-xs text-muted-foreground">
              Found by name in this workspace. Archived campaigns don&apos;t
              count — an active, paused or completed one all take leads. Nothing
              is created, no copy is changed and nothing is launched.
            </p>
            <div className="space-y-2">
              {moveMatch.matches.map((m) => (
                <div
                  key={m.role}
                  className="flex flex-col gap-1 rounded-lg border border-border/70 p-2.5 sm:flex-row sm:items-center sm:justify-between"
                  data-move-row={m.role}
                >
                  <div className="min-w-0">
                    <div className="truncate font-mono text-xs">
                      {m.match?.name ?? m.expectedName}
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      {ROLE_LABELS[m.role]}
                    </div>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                      m.match
                        ? "bg-success/10 text-success"
                        : "bg-danger/10 text-danger"
                    }`}
                  >
                    {m.match
                      ? m.loose
                        ? "found — check it is the right one"
                        : "found"
                      : m.ambiguous
                        ? "two share this name — skipped"
                        : "not found — skipped"}
                  </span>
                </div>
              ))}
            </div>
            {foundCount === 0 && (
              <p className="mt-3 text-xs text-danger">
                There is nowhere to move anything. Check the names in Plusvibe
                read exactly as above, and that none of them is archived.
              </p>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              Microsoft recipients go to the 🔵 campaigns, everyone else to the
              rest, and the source keeps a share.
              {missingCount > 0 && foundCount > 0 && (
                <>
                  {" "}
                  A campaign that isn&apos;t there is skipped and its share
                  stays with the others in its group
                  {blueFound
                    ? "."
                    : " — and with no 🔵 campaign at all, the Microsoft leads stay in the source."}
                </>
              )}
            </p>
          </div>
        )}

        {!showSettings && mode === "create" && source && names && (
          <div className="rounded-xl border border-border p-3 sm:p-4">
            <h3 className="mb-1 text-sm font-medium">
              Five campaigns will be created
            </h3>
            <p className="mb-3 text-xs text-muted-foreground">
              Duplicated from{" "}
              <span className="font-mono">{source.name}</span> with their
              sub-sequences. Leads aren&apos;t copied — they&apos;re split
              deliberately in step 3.
            </p>
            <div className="space-y-2">
              {rows.map((r) => (
                <div
                  key={r.role}
                  className="flex flex-col gap-1 rounded-lg border border-border/70 p-2.5 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="truncate font-mono text-xs">{r.name}</div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      {ROLE_LABELS[r.role]}
                    </div>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                      r.reused
                        ? "bg-warning/10 text-warning"
                        : "bg-success/10 text-success"
                    }`}
                  >
                    {r.reused
                      ? "already exists — will be reused"
                      : r.replacesArchived
                        ? "replaces an archived one — will be created"
                        : "will be created"}
                  </span>
                </div>
              ))}
            </div>
            {archivedCount > 0 && (
              <p className="mt-3 text-xs text-muted-foreground">
                {archivedCount === 1 ? "One of these names is" : "Some of these names are"}{" "}
                held only by an archived campaign. Archived campaigns can&apos;t
                take leads, so {archivedCount === 1 ? "a fresh one is" : "fresh ones are"}{" "}
                created under the same name and the archived{" "}
                {archivedCount === 1 ? "one is" : "ones are"} left alone.
              </p>
            )}
            {reusedCount > 0 && (
              <p className="mt-3 text-xs text-muted-foreground">
                {reusedCount === 1 ? "A campaign" : `${reusedCount} campaigns`}{" "}
                with {reusedCount === 1 ? "this name" : "these names"} already
                exist{reusedCount === 1 ? "s" : ""}, so{" "}
                {reusedCount === 1 ? "it" : "they"} will be used as-is rather
                than duplicated again. That&apos;s what makes re-running after an
                interrupted job safe.
              </p>
            )}

            <p className="mt-3 text-xs text-muted-foreground" data-settings-summary>
              {describeDominant(settings.dominant)} {describeLimits(settings)} —{" "}
              <button
                type="button"
                className="underline hover:text-foreground"
                onClick={() => setShowSettings(true)}
              >
                change in Settings
              </button>
              .
            </p>

            <label className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={activate}
                onChange={(e) => setActivate(e.target.checked)}
              />
              <span>
                Activate all six campaigns at the end, sub-sequences included.
                Untick to leave the five copies as drafts and launch them
                yourself.
              </span>
            </label>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger">
            <AlertIcon size={16} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className={`flex flex-wrap items-center gap-3 ${showSettings ? "hidden" : ""}`}>
          <button
            type="button"
            className="pv-btn-primary disabled:opacity-50"
            disabled={!canStart}
            onClick={handleStart}
            data-start
          >
            {starting ? <Spinner /> : mode === "move" ? <MoveIcon size={16} /> : <LayersIcon size={16} />}
            {activeJob || queuedCount > 0
              ? "Add to queue"
              : mode === "move"
                ? "Move leads"
                : "Start"}
          </button>
          {alreadyPending ? (
            <span className="text-xs text-warning">
              This campaign is already {activeJob?.sourceCampaignId === sourceId
                ? "being processed"
                : "in the queue"}
              .
            </span>
          ) : activeJob ? (
            <span className="text-xs text-muted-foreground">
              A job is running
              {queuedCount > 0
                ? ` and ${formatNumber(queuedCount)} more ${
                    queuedCount === 1 ? "is" : "are"
                  } queued`
                : ""}
              . This one waits its turn — jobs run one at a time, in the order
              you start them, so the campaigns come out in order.
            </span>
          ) : null}
        </div>
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-semibold">Jobs</h2>
        {jobs.length === 0 ? (
          <EmptyState icon={<LayersIcon />} title="No jobs yet">
            Pick the original campaign and start — the run keeps going even if
            you close this tab.
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
        )}
      </div>

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

function errMessage(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  return err instanceof Error ? err.message : "Something went wrong";
}
