"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Workspace } from "@/lib/plusvibe-types";
import {
  CYCLE_COUNT,
  DEFAULT_SETTINGS,
  GROUPS,
  PROFILES,
  STAGES,
  describeSetup,
  stageLabel,
  validateProfile,
  cleanProfile,
  type Group,
  type InboxClass,
  type Profile,
  type ProfileKey,
  type RotationSettings,
  type Stage,
} from "@/lib/inbox-rotation/settings";
import { describePosition, todayIn } from "@/lib/inbox-rotation/schedule";
import { groupTotal, profilesPresent } from "@/lib/inbox-rotation/inventory";
import {
  fetchWorkspaces,
  fetchInboxRotationSettings,
  saveInboxRotationSettings,
  fetchInboxRotations,
  setUpInboxRotation,
  removeInboxRotation,
  applyInboxRotation,
  ApiClientError,
  type RotationListItem,
} from "@/lib/api-client";
import { useApiKey } from "@/lib/use-api-key";
import { ConnectPrompt } from "@/components/connect-prompt";
import { Spinner, EmptyState, RemoveJobButton } from "@/components/ui";
import { AlertIcon, CheckIcon, ChevronDownIcon, RefreshIcon } from "@/components/icons";

// Three views: set a workspace up, edit the settings the rotation applies,
// and see where every workspace stands. The rotating itself is done on the
// server (inbox-rotation/runner.ts); this page reads its state and can ask
// it to apply today's settings now.

const POLL_MS = 3000;
const CLASS_LABEL: Record<InboxClass, string> = { azure50: "Azure (50)", azure25: "Azure (25)", google: "Google", other: "other" };

type View = "setup" | "settings" | "rotations";

const VIEWS: { key: View; label: string }[] = [
  { key: "setup", label: "Set Up New Workspace" },
  { key: "settings", label: "Settings" },
  { key: "rotations", label: "Current Rotations" },
];

/** A profile as typed: strings, so a field can be cleared while editing. */
interface ProfileDraft {
  cycles: { dayLength: string; dailySends: string; emailInterval: string; warmupEmails: string }[];
  maintaining: { dayLengthMin: string; dayLengthMax: string; dailySendsMin: string; dailySendsMax: string; emailInterval: string; warmupEmails: string };
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
      dailySendsMin: String(p.maintaining.dailySendsMin),
      dailySendsMax: String(p.maintaining.dailySendsMax),
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
  const [startDate, setStartDate] = useState<string>(() => todayIn());
  const [stage, setStage] = useState<Stage>(1);
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
  const [rotations, setRotations] = useState<RotationListItem[]>([]);
  const [serverKey, setServerKey] = useState(true);
  const [rotationsError, setRotationsError] = useState<string | null>(null);
  const loadRotations = useCallback(async () => {
    try {
      const r = await fetchInboxRotations();
      setRotations(r.rotations);
      setServerKey(r.serverKey);
    } catch (err) {
      setRotationsError(errMessage(err));
    }
  }, []);
  // A run in progress: keep reading until it has finished.
  const anyRunning = rotations.some((r) => r.running);
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => void loadRotations(), POLL_MS);
    return () => clearInterval(t);
  }, [anyRunning, loadRotations]);

  useEffect(() => {
    if (ready && hasKey) {
      void loadWorkspaces();
      void loadSettings();
      void loadRotations();
    }
  }, [ready, hasKey, loadWorkspaces, loadSettings, loadRotations]);

  const workspace = workspaces.find((w) => w._id === workspaceId) ?? null;
  const alreadySetUp = rotations.find((r) => r.workspaceId === workspaceId) ?? null;
  const canSetUp = !!workspace && !settingUp && /^\d{4}-\d{2}-\d{2}$/.test(startDate);

  async function handleSetUp() {
    if (!workspace || !canSetUp) return;
    setSettingUp(true);
    setSetupError(null);
    try {
      await setUpInboxRotation({ workspaceId: workspace._id, workspaceName: workspace.name, startingGroup, startDate, stage });
      await loadRotations();
      setToast(`${workspace.name} set up — ${describeSetup({ startingGroup, startDate, stage })}`);
      setTimeout(() => setToast(null), 5000);
      setView("rotations");
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
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground" htmlFor="rotation-start">
                Start date
              </label>
              <input
                id="rotation-start"
                type="date"
                className="pv-input"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                aria-label="Start date"
              />
            </div>
          </div>

          <div>
            <div className="mb-1.5 text-xs font-medium text-muted-foreground">Stage</div>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Stage">
              {STAGES.map((st) => (
                <button
                  key={String(st.key)}
                  type="button"
                  role="radio"
                  aria-checked={stage === st.key}
                  className={`pv-chip ${stage === st.key ? "pv-chip-active" : "hover:text-foreground"}`}
                  onClick={() => setStage(st.key)}
                >
                  {st.label}
                </button>
              ))}
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
                      <div>
                        <div className="mb-1 text-[11px] text-muted-foreground">Daily Sends</div>
                        <div className="flex items-center gap-1">
                          <input type="number" className="pv-input px-2 text-sm" min={0} step={1} value={d.maintaining.dailySendsMin} onChange={(e) => setMaintaining(p.key, "dailySendsMin", e.target.value)} aria-label={`${p.label} · Maintaining · Daily Sends from`} />
                          <span className="text-xs text-muted-foreground">–</span>
                          <input type="number" className="pv-input px-2 text-sm" min={0} step={1} value={d.maintaining.dailySendsMax} onChange={(e) => setMaintaining(p.key, "dailySendsMax", e.target.value)} aria-label={`${p.label} · Maintaining · Daily Sends to`} />
                        </div>
                      </div>
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
            <span className="text-xs text-muted-foreground">Day Length: days until the switch · Daily Sends: daily campaign email limit · Email Interval: minimum minutes between emails · Warmup Emails: warmup daily limit — per cycle while sending, and once for the group not sending cold · Maintaining ranges: drawn at random for each turn</span>
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
          {!serverKey && rotations.length > 0 && (
            <p className="flex gap-1.5 text-xs text-warning">
              <AlertIcon size={13} className="mt-0.5 shrink-0" />
              <span>No server API key is set, so switches are only written when this page applies them.</span>
            </p>
          )}
          {rotations.length === 0 ? (
            <EmptyState icon={<RefreshIcon />} title="No workspaces set up yet">
              Set one up from the first tab.
            </EmptyState>
          ) : (
            rotations.map((r) => (
              <RotationCard
                key={r.id}
                r={r}
                onApply={async () => {
                  try {
                    await applyInboxRotation(r.id, true);
                    await loadRotations();
                  } catch (err) {
                    setRotationsError(errMessage(err));
                  }
                }}
                onRemove={async () => {
                  try {
                    await removeInboxRotation(r.id);
                    await loadRotations();
                  } catch (err) {
                    setRotationsError(errMessage(err));
                  }
                }}
              />
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

function RotationCard({
  r,
  onApply,
  onRemove,
}: {
  r: RotationListItem;
  onApply: () => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const inv = r.inventory;
  const present = inv ? profilesPresent(inv) : [];
  // One line when every profile stands in the same place, which is the
  // usual case; a line per profile when their day lengths differ.
  const lines = present.map((key) => ({ key, text: describePosition(r.positions[key] ?? { kind: "notStarted", startsIn: 0 }) }));
  const same = lines.length > 0 && lines.every((l) => l.text === lines[0].text);
  const run = r.lastRun;
  const groupLine = (g: Group) => {
    if (!inv) return "not read yet";
    if (!inv.tagsFound.includes(g)) return "no such tag in this workspace";
    const parts = (["azure50", "azure25", "google", "other"] as InboxClass[])
      .filter((c) => (inv.groups[g]?.[c] ?? 0) > 0)
      .map((c) => `${CLASS_LABEL[c]} ${inv.groups[g][c]}`);
    const total = groupTotal(inv, g);
    return `${total} inbox${total === 1 ? "" : "es"}${parts.length > 0 ? ` — ${parts.join(" · ")}` : ""}`;
  };
  return (
    <div className="pv-card space-y-3 p-4" data-rotation={r.workspaceId}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{r.workspaceName || r.workspaceId}</div>
          <div className="text-xs text-muted-foreground">{describeSetup(r)}</div>
        </div>
        <div className="flex items-center gap-2">
          {r.running && (
            <span className="pv-chip">
              <Spinner size={10} /> applying
            </span>
          )}
          <button type="button" className="pv-btn-ghost text-xs" disabled={r.running} onClick={() => void onApply()} data-apply>
            <RefreshIcon size={13} /> Apply now
          </button>
          <RemoveJobButton onRemove={onRemove} />
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {GROUPS.map((g) => (
          <div key={g.key} className="rounded-xl border border-border p-2.5 text-xs">
            <div className="font-medium">{g.label}</div>
            <div className="text-muted-foreground">{groupLine(g.key)}</div>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-accent/40 bg-accent/5 p-2.5 text-xs" data-sending>
        {lines.length === 0 ? (
          <span className="text-muted-foreground">{inv ? "No inboxes in either group." : "Not applied yet."}</span>
        ) : same ? (
          <span className="font-medium">{lines[0].text}</span>
        ) : (
          <div className="space-y-0.5">
            {lines.map((l) => (
              <div key={l.key}>
                <span className="text-muted-foreground">{PROFILES.find((p) => p.key === l.key)?.label}: </span>
                <span className="font-medium">{l.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {run && (
        <div className="text-xs text-muted-foreground">
          {run.finishedAt
            ? `Last applied ${relativeTime(run.finishedAt)} for ${run.day} · ${run.updated} inbox${run.updated === 1 ? "" : "es"} written`
            : `Applying for ${run.day}…`}
          {inv && inv.untagged > 0 ? ` · ${inv.untagged} untagged left alone` : ""}
          {(inv?.groups[1]?.other ?? 0) + (inv?.groups[2]?.other ?? 0) > 0
            ? ` · ${(inv?.groups[1]?.other ?? 0) + (inv?.groups[2]?.other ?? 0)} neither Microsoft nor Google, left alone`
            : ""}
        </div>
      )}
      {run && run.errors.length > 0 && (
        <div className="space-y-1">
          {run.errors.slice(0, 4).map((e, i) => (
            <p key={i} className="flex gap-1.5 text-xs text-warning">
              <AlertIcon size={13} className="mt-0.5 shrink-0" />
              <span>{e}</span>
            </p>
          ))}
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
