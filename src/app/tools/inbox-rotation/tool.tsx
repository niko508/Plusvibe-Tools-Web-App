"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Workspace } from "@/lib/plusvibe-types";
import {
  CYCLE_COUNT,
  DEFAULT_SETTINGS,
  GROUPS,
  PHASES,
  PROFILES,
  describeSetup,
  validateProfile,
  cleanProfile,
  type Group,
  type Phase,
  type Profile,
  type ProfileKey,
  type RotationSettings,
  type WorkspaceRotation,
} from "@/lib/inbox-rotation/settings";
import {
  fetchWorkspaces,
  fetchInboxRotationSettings,
  saveInboxRotationSettings,
  fetchInboxRotations,
  setUpInboxRotation,
  removeInboxRotation,
  ApiClientError,
} from "@/lib/api-client";
import { useApiKey } from "@/lib/use-api-key";
import { ConnectPrompt } from "@/components/connect-prompt";
import { Spinner, EmptyState, RemoveJobButton } from "@/components/ui";
import { AlertIcon, CheckIcon, ChevronDownIcon, RefreshIcon } from "@/components/icons";

// Three views: set a workspace up, edit the settings the rotation applies,
// and see what is set up. The schedule that does the rotating is not here
// yet; this is the settings and the set-up records.

type View = "setup" | "settings" | "rotations";

const VIEWS: { key: View; label: string }[] = [
  { key: "setup", label: "Set Up New Workspace" },
  { key: "settings", label: "Settings" },
  { key: "rotations", label: "Current Rotations" },
];

/** A profile as typed: strings, so a field can be cleared while editing. */
interface ProfileDraft {
  cycles: { dayLength: string; dailySends: string; emailInterval: string; warmupEmails: string }[];
  maintaining: { dayLengthMin: string; dayLengthMax: string; dailySends: string; emailInterval: string; warmupEmails: string };
  resting: { warmupEmails: string };
}

function toDraft(p: Profile): ProfileDraft {
  return {
    cycles: p.cycles.map((c) => ({
      dayLength: String(c.dayLength),
      dailySends: String(c.dailySends),
      emailInterval: String(c.emailInterval),
      warmupEmails: String(c.warmupEmails),
    })),
    maintaining: {
      dayLengthMin: String(p.maintaining.dayLengthMin),
      dayLengthMax: String(p.maintaining.dayLengthMax),
      dailySends: String(p.maintaining.dailySends),
      emailInterval: String(p.maintaining.emailInterval),
      warmupEmails: String(p.maintaining.warmupEmails),
    },
    resting: { warmupEmails: String(p.resting.warmupEmails) },
  };
}

export function InboxRotationTool() {
  const { hasKey, ready } = useApiKey();
  const [view, setView] = useState<View>("setup");

  // --- Settings ------------------------------------------------------------
  const [settings, setSettings] = useState<RotationSettings>(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [drafts, setDrafts] = useState<Record<ProfileKey, ProfileDraft>>(() => ({
    azure50: toDraft(DEFAULT_SETTINGS.profiles.azure50),
    azure25: toDraft(DEFAULT_SETTINGS.profiles.azure25),
    google: toDraft(DEFAULT_SETTINGS.profiles.google),
  }));
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsNote, setSettingsNote] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    try {
      const { settings: s } = await fetchInboxRotationSettings();
      setSettings(s);
      setDrafts({ azure50: toDraft(s.profiles.azure50), azure25: toDraft(s.profiles.azure25), google: toDraft(s.profiles.google) });
      setSettingsLoaded(true);
    } catch (err) {
      setSettingsError(errMessage(err));
    }
  }, []);

  const problems = useMemo(() => {
    const out = {} as Record<ProfileKey, string[]>;
    for (const p of PROFILES) out[p.key] = validateProfile(drafts[p.key], p.label);
    return out;
  }, [drafts]);
  const anyProblem = PROFILES.some((p) => problems[p.key].length > 0);
  const dirty = useMemo(
    () => PROFILES.some((p) => JSON.stringify(drafts[p.key]) !== JSON.stringify(toDraft(settings.profiles[p.key]))),
    [drafts, settings]
  );
  const canSave = settingsLoaded && dirty && !anyProblem && !savingSettings;

  function setCycle(key: ProfileKey, i: number, field: keyof ProfileDraft["cycles"][number], value: string) {
    setDrafts((prev) => ({
      ...prev,
      [key]: { ...prev[key], cycles: prev[key].cycles.map((c, j) => (j === i ? { ...c, [field]: value } : c)) },
    }));
  }
  function setMaintaining(key: ProfileKey, field: keyof ProfileDraft["maintaining"], value: string) {
    setDrafts((prev) => ({ ...prev, [key]: { ...prev[key], maintaining: { ...prev[key].maintaining, [field]: value } } }));
  }
  function setResting(key: ProfileKey, value: string) {
    setDrafts((prev) => ({ ...prev, [key]: { ...prev[key], resting: { warmupEmails: value } } }));
  }

  async function handleSaveSettings() {
    if (!canSave) return;
    setSavingSettings(true);
    setSettingsError(null);
    setSettingsNote(null);
    try {
      const profiles = {} as Record<ProfileKey, Profile>;
      for (const p of PROFILES) profiles[p.key] = cleanProfile(drafts[p.key]);
      const { settings: s } = await saveInboxRotationSettings(profiles);
      setSettings(s);
      setDrafts({ azure50: toDraft(s.profiles.azure50), azure25: toDraft(s.profiles.azure25), google: toDraft(s.profiles.google) });
      setSettingsNote("Saved.");
      setTimeout(() => setSettingsNote(null), 4000);
    } catch (err) {
      setSettingsError(errMessage(err));
    } finally {
      setSavingSettings(false);
    }
  }

  // --- Workspaces and set-up -------------------------------------------------
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(false);
  const [workspaceId, setWorkspaceId] = useState("");
  const [startingGroup, setStartingGroup] = useState<Group>(1);
  const [phase, setPhase] = useState<Phase>("rampUp");
  const [settingUp, setSettingUp] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const loadWorkspaces = useCallback(async () => {
    setWorkspacesLoading(true);
    setSetupError(null);
    try {
      const { workspaces: list } = await fetchWorkspaces();
      setWorkspaces(list);
    } catch (err) {
      setSetupError(errMessage(err));
    } finally {
      setWorkspacesLoading(false);
    }
  }, []);

  // --- Rotations -------------------------------------------------------------
  const [rotations, setRotations] = useState<WorkspaceRotation[]>([]);
  const [rotationsError, setRotationsError] = useState<string | null>(null);
  const loadRotations = useCallback(async () => {
    try {
      setRotations((await fetchInboxRotations()).rotations);
    } catch (err) {
      setRotationsError(errMessage(err));
    }
  }, []);

  useEffect(() => {
    if (ready && hasKey) {
      void loadWorkspaces();
      void loadSettings();
      void loadRotations();
    }
  }, [ready, hasKey, loadWorkspaces, loadSettings, loadRotations]);

  const workspace = workspaces.find((w) => w._id === workspaceId) ?? null;
  const alreadySetUp = rotations.find((r) => r.workspaceId === workspaceId) ?? null;
  const canSetUp = !!workspace && !settingUp;

  async function handleSetUp() {
    if (!workspace || !canSetUp) return;
    setSettingUp(true);
    setSetupError(null);
    try {
      await setUpInboxRotation({ workspaceId: workspace._id, workspaceName: workspace.name, startingGroup, phase });
      await loadRotations();
      setToast(`${workspace.name} set up — ${describeSetup({ startingGroup, phase })}`);
      setTimeout(() => setToast(null), 5000);
    } catch (err) {
      setSetupError(errMessage(err));
    } finally {
      setSettingUp(false);
    }
  }

  if (!ready) return <div className="pv-card h-40 animate-pulse" />;
  if (!hasKey) return <ConnectPrompt onConnected={loadWorkspaces} />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="View">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            type="button"
            role="tab"
            aria-selected={view === v.key}
            className={`pv-chip ${view === v.key ? "pv-chip-active" : "hover:text-foreground"}`}
            onClick={() => setView(v.key)}
            data-view={v.key}
          >
            {v.label}
            {v.key === "rotations" && rotations.length > 0 && (
              <span className="text-muted-foreground">{rotations.length}</span>
            )}
          </button>
        ))}
      </div>

      {view === "setup" && (
        <div className="pv-card space-y-4 p-4 sm:p-5" data-setup>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Workspace</label>
              <div className="relative">
                <select
                  className="pv-input appearance-none pr-9"
                  value={workspaceId}
                  disabled={workspacesLoading}
                  onChange={(e) => setWorkspaceId(e.target.value)}
                  aria-label="Workspace"
                >
                  <option value="">{workspacesLoading ? "Loading workspaces…" : "Select a workspace…"}</option>
                  {workspaces.map((w) => (
                    <option key={w._id} value={w._id}>
                      {w.name}
                    </option>
                  ))}
                </select>
                <ChevronDownIcon size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              </div>
              {alreadySetUp && (
                <p className="mt-1.5 flex gap-1.5 text-xs text-warning">
                  <AlertIcon size={13} className="mt-0.5 shrink-0" />
                  <span>Already set up — {describeSetup(alreadySetUp)}. Setting it up again replaces that.</span>
                </p>
              )}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <div className="mb-1.5 text-xs font-medium text-muted-foreground">Which group starts</div>
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Which group starts">
                {GROUPS.map((g) => (
                  <button
                    key={g.key}
                    type="button"
                    role="radio"
                    aria-checked={startingGroup === g.key}
                    className={`pv-chip ${startingGroup === g.key ? "pv-chip-active" : "hover:text-foreground"}`}
                    onClick={() => setStartingGroup(g.key)}
                  >
                    {g.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-xs font-medium text-muted-foreground">Starting period</div>
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Starting period">
                {PHASES.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    role="radio"
                    aria-checked={phase === p.key}
                    className={`pv-chip ${phase === p.key ? "pv-chip-active" : "hover:text-foreground"}`}
                    onClick={() => setPhase(p.key)}
                    title={p.hint}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] text-muted-foreground">{PHASES.find((p) => p.key === phase)?.hint}</p>
            </div>
          </div>

          {setupError && (
            <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger">
              <AlertIcon size={16} className="mt-0.5 shrink-0" />
              <span>{setupError}</span>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className="pv-btn-primary disabled:opacity-50" disabled={!canSetUp} onClick={handleSetUp} data-setup-start>
              {settingUp ? <Spinner /> : <RefreshIcon size={16} />}
              {alreadySetUp ? "Set up again" : "Set up workspace"}
            </button>
            {!workspace && !workspacesLoading && <span className="text-xs text-muted-foreground">Pick a workspace first.</span>}
          </div>
        </div>
      )}

      {view === "settings" && (
        <div className="space-y-4" data-settings>
          <div className="grid gap-4 lg:grid-cols-3">
            {PROFILES.map((p) => {
              const d = drafts[p.key];
              const ps = problems[p.key];
              return (
                <div key={p.key} className="pv-card space-y-3 p-4" data-profile={p.key}>
                  <div>
                    <h2 className="text-sm font-semibold">{p.label}</h2>
                    <p className="text-[11px] text-muted-foreground">{p.hint}</p>
                  </div>
                  {d.cycles.slice(0, CYCLE_COUNT).map((c, i) => (
                    <fieldset key={i} className="rounded-xl border border-border p-2.5">
                      <legend className="px-1 text-xs font-medium">Cycle {i + 1}</legend>
                      <div className="grid grid-cols-2 gap-2">
                        <Field label="Day Length" aria={`${p.label} · Cycle ${i + 1} · Day Length`} value={c.dayLength} onChange={(v) => setCycle(p.key, i, "dayLength", v)} />
                        <Field label="Daily Sends" aria={`${p.label} · Cycle ${i + 1} · Daily Sends`} value={c.dailySends} onChange={(v) => setCycle(p.key, i, "dailySends", v)} />
                        <Field label="Email Interval" aria={`${p.label} · Cycle ${i + 1} · Email Interval`} value={c.emailInterval} onChange={(v) => setCycle(p.key, i, "emailInterval", v)} unit="min" />
                        <Field label="Warmup Emails" aria={`${p.label} · Cycle ${i + 1} · Warmup Emails`} value={c.warmupEmails} onChange={(v) => setCycle(p.key, i, "warmupEmails", v)} />
                      </div>
                    </fieldset>
                  ))}
                  <fieldset className="rounded-xl border border-accent/40 p-2.5">
                    <legend className="px-1 text-xs font-medium">Maintaining Period</legend>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <div className="mb-1 text-[11px] text-muted-foreground">Day Length</div>
                        <div className="flex items-center gap-1">
                          <input type="number" className="pv-input px-2 text-sm" min={1} step={1} value={d.maintaining.dayLengthMin} onChange={(e) => setMaintaining(p.key, "dayLengthMin", e.target.value)} aria-label={`${p.label} · Maintaining · Day Length from`} />
                          <span className="text-xs text-muted-foreground">–</span>
                          <input type="number" className="pv-input px-2 text-sm" min={1} step={1} value={d.maintaining.dayLengthMax} onChange={(e) => setMaintaining(p.key, "dayLengthMax", e.target.value)} aria-label={`${p.label} · Maintaining · Day Length to`} />
                        </div>
                      </div>
                      <Field label="Daily Sends" aria={`${p.label} · Maintaining · Daily Sends`} value={d.maintaining.dailySends} onChange={(v) => setMaintaining(p.key, "dailySends", v)} />
                      <Field label="Email Interval" aria={`${p.label} · Maintaining · Email Interval`} value={d.maintaining.emailInterval} onChange={(v) => setMaintaining(p.key, "emailInterval", v)} unit="min" />
                      <Field label="Warmup Emails" aria={`${p.label} · Maintaining · Warmup Emails`} value={d.maintaining.warmupEmails} onChange={(v) => setMaintaining(p.key, "warmupEmails", v)} />
                    </div>
                  </fieldset>
                  <fieldset className="rounded-xl border border-border border-dashed p-2.5">
                    <legend className="px-1 text-xs font-medium">Not sending cold</legend>
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="Warmup Emails" aria={`${p.label} · Not sending cold · Warmup Emails`} value={d.resting.warmupEmails} onChange={(v) => setResting(p.key, v)} />
                    </div>
                  </fieldset>
                  {ps.length > 0 && (
                    <p className="flex gap-1.5 text-xs text-warning">
                      <AlertIcon size={13} className="mt-0.5 shrink-0" />
                      <span>{ps[0]}{ps.length > 1 ? ` (+${ps.length - 1} more)` : ""}</span>
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          <div className="pv-card flex flex-wrap items-center gap-3 p-4">
            <span className="pv-chip" title="Set off on every inbox the rotation touches">
              Campaign Email Ramp-Up · always disabled
            </span>
            <span className="text-xs text-muted-foreground">Day Length: days until the switch · Daily Sends: daily campaign email limit · Email Interval: minimum minutes between emails · Warmup Emails: warmup daily limit — per cycle while sending, and once for the group not sending cold</span>
          </div>

          {settingsError && (
            <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger">
              <AlertIcon size={16} className="mt-0.5 shrink-0" />
              <span>{settingsError}</span>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className="pv-btn-primary disabled:opacity-50" disabled={!canSave} onClick={handleSaveSettings} data-save-settings>
              {savingSettings ? <Spinner /> : <CheckIcon size={16} />}
              Save settings
            </button>
            {settingsNote ? (
              <span className="text-xs text-success">{settingsNote}</span>
            ) : !settingsLoaded ? (
              <span className="text-xs text-muted-foreground">Reading the saved settings…</span>
            ) : dirty ? (
              <span className="text-xs text-muted-foreground">Not saved yet.</span>
            ) : null}
          </div>
        </div>
      )}

      {view === "rotations" && (
        <div className="space-y-3" data-rotations>
          {rotationsError && (
            <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger">
              <AlertIcon size={16} className="mt-0.5 shrink-0" />
              <span>{rotationsError}</span>
            </div>
          )}
          {rotations.length === 0 ? (
            <EmptyState icon={<RefreshIcon />} title="No workspaces set up yet">
              Set one up from the first tab.
            </EmptyState>
          ) : (
            rotations.map((r) => (
              <div key={r.id} className="pv-card flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{r.workspaceName || r.workspaceId}</div>
                  <div className="text-xs text-muted-foreground">{describeSetup(r)} · set up {relativeTime(r.createdAt)}</div>
                </div>
                <RemoveJobButton
                  onRemove={async () => {
                    try {
                      await removeInboxRotation(r.id);
                      await loadRotations();
                    } catch (err) {
                      setRotationsError(errMessage(err));
                    }
                  }}
                />
              </div>
            ))
          )}
        </div>
      )}

      {toast && (
        <div className="fixed bottom-5 right-5 z-50 animate-fade-in">
          <div className="pv-card flex items-center gap-3 border-success/40 px-4 py-3 shadow-card">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-success/15 text-success">
              <CheckIcon size={16} />
            </span>
            <span className="text-sm font-medium">{toast}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  aria,
  value,
  onChange,
  unit,
}: {
  label: string;
  aria: string;
  value: string;
  onChange: (v: string) => void;
  unit?: string;
}) {
  return (
    <div>
      <div className="mb-1 text-[11px] text-muted-foreground">
        {label}
        {unit ? ` (${unit})` : ""}
      </div>
      <input
        type="number"
        className="pv-input px-2 text-sm"
        min={0}
        step={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={aria}
      />
    </div>
  );
}

function relativeTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function errMessage(err: unknown): string {
  return err instanceof ApiClientError ? err.message : err instanceof Error ? err.message : "Something went wrong";
}
