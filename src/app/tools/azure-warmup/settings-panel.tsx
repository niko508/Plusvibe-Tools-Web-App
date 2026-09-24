"use client";

import { useEffect, useMemo, useState } from "react";
import { getAzureWarmupSettings, saveAzureWarmupSettings } from "@/lib/api-client";
import {
  DEFAULT_WARMUP_SETTINGS,
  WARMUP_LIMITS,
  WEEK_DAYS,
  describeWarmup,
  validateWarmupSettings,
  type WarmupSettings,
  type WeekDay,
} from "@/lib/azure-warmup/warmup-settings";
import { Spinner } from "@/components/ui";
import { AlertIcon, CheckIcon } from "@/components/icons";

/** What the form holds: numbers as typed, so a half-typed field isn't forced to 0. */
type Draft = Omit<WarmupSettings, "initialDailyLimit" | "paceIncrement" | "maxDailyLimit" | "randomizeNum" | "replyRatePct"> & {
  initialDailyLimit: string;
  paceIncrement: string;
  maxDailyLimit: string;
  randomizeNum: string;
  replyRatePct: string;
};

const toDraft = (s: WarmupSettings): Draft => ({
  ...s,
  initialDailyLimit: String(s.initialDailyLimit),
  paceIncrement: String(s.paceIncrement),
  maxDailyLimit: String(s.maxDailyLimit),
  randomizeNum: String(s.randomizeNum),
  replyRatePct: String(s.replyRatePct),
});

const same = (a: WarmupSettings, b: WarmupSettings) => JSON.stringify(a) === JSON.stringify(b);

/** Every IANA zone the browser knows, for the time zone suggestions. */
function timeZones(): string[] {
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone");
    if (list && list.length > 0) return list;
  } catch {
    // older browser: the field still takes any name typed
  }
  return ["UTC", "Asia/Singapore", "Europe/Helsinki", "Europe/London", "America/New_York", "America/Los_Angeles"];
}

export function WarmupSettingsPanel({ onSaved }: { onSaved?: (s: WarmupSettings) => void }) {
  const [saved, setSaved] = useState<WarmupSettings | null>(null);
  const [savedAt, setSavedAt] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const zones = useMemo(timeZones, []);

  useEffect(() => {
    let live = true;
    getAzureWarmupSettings()
      .then((r) => {
        if (!live) return;
        setSaved(r.settings);
        setSavedAt(r.updatedAt);
        setDraft(toDraft(r.settings));
      })
      .catch((err) => live && setLoadError(err instanceof Error ? err.message : "Could not load the settings."));
    return () => {
      live = false;
    };
  }, []);

  const checked = useMemo(() => (draft ? validateWarmupSettings(draft) : null), [draft]);
  const dirty = !!(checked?.settings && saved && !same(checked.settings, saved));
  const isDefault = !!(checked?.settings && same(checked.settings, DEFAULT_WARMUP_SETTINGS));

  if (loadError) {
    return (
      <div className="pv-card flex items-start gap-2 p-4 text-sm text-danger sm:p-5">
        <AlertIcon size={16} className="mt-0.5 shrink-0" /> {loadError}
      </div>
    );
  }
  if (!draft || !saved) return <div className="pv-card h-64 animate-pulse" />;

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setJustSaved(false);
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  };
  const toggleDay = (day: WeekDay) =>
    set("days", draft.days.includes(day) ? draft.days.filter((d) => d !== day) : WEEK_DAYS.filter((d) => d === day || draft.days.includes(d)));

  async function save() {
    if (!checked?.settings) return;
    setSaving(true);
    setSaveError(null);
    try {
      const r = await saveAzureWarmupSettings(checked.settings);
      setSaved(r.settings);
      setSavedAt(r.updatedAt);
      setDraft(toDraft(r.settings));
      setJustSaved(true);
      onSaved?.(r.settings);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  const L = WARMUP_LIMITS;
  const num = (key: "initialDailyLimit" | "paceIncrement" | "maxDailyLimit" | "randomizeNum" | "replyRatePct", label: string, hint: string, min: number, max: number, suffix?: string, disabled?: boolean) => (
    <label className={`block ${disabled ? "opacity-50" : ""}`}>
      <span className="mb-1.5 block text-sm font-medium">{label}</span>
      <span className="flex items-center gap-2">
        <input
          type="number"
          inputMode="numeric"
          className="pv-input w-28 tabular-nums"
          min={min}
          max={max}
          value={draft[key]}
          disabled={disabled}
          aria-label={label}
          data-setting={key}
          onChange={(e) => set(key, e.target.value)}
        />
        {suffix && <span className="text-sm text-muted-foreground">{suffix}</span>}
      </span>
      <span className="mt-1 block text-xs text-muted-foreground">{hint}</span>
    </label>
  );
  const toggle = (key: "slowRampup" | "randomize", label: string, hint: string) => (
    <div>
      <button
        type="button"
        role="switch"
        aria-checked={draft[key]}
        data-setting={key}
        onClick={() => set(key, !draft[key])}
        className={`pv-chip ${draft[key] ? "pv-chip-active" : "hover:text-foreground"}`}
      >
        {draft[key] ? <CheckIcon size={12} /> : null} {label}: {draft[key] ? "on" : "off"}
      </button>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </div>
  );

  return (
    <div className="pv-card space-y-6 p-4 sm:p-5" data-warmup-settings>
      <div>
        <h2 className="text-base font-semibold">Warmup settings</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Applied to every inbox a run starts warming. A run takes a copy when it starts, so changes here apply to the next
          run — runs already going keep the settings they started with.
        </p>
      </div>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Daily volume</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          {num("initialDailyLimit", "Start at", "Warmup emails a day on day one.", L.dailyLimit.min, L.dailyLimit.max, "per day")}
          {num("paceIncrement", "Increase by", "Added each day until the maximum.", L.paceIncrement.min, L.paceIncrement.max, "per day")}
          {num("maxDailyLimit", "Maximum", "The most warmup emails a day.", L.dailyLimit.min, L.dailyLimit.max, "per day")}
        </div>
        {toggle("slowRampup", "Slow ramp-up", "Plusvibe's slow ramp-up for warmup.")}
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Behaviour</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-3">
            {toggle("randomize", "Randomize", "Vary the daily count so it doesn't look mechanical.")}
            {num("randomizeNum", "Randomize by", "How far the daily count may vary.", L.randomizeNum.min, L.randomizeNum.max, "emails", !draft.randomize)}
          </div>
          {num("replyRatePct", "Reply rate", "Share of warmup emails that get a reply.", L.replyRatePct.min, L.replyRatePct.max, "%")}
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Schedule</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Time zone</span>
            <input
              className="pv-input"
              list="warmup-zones"
              value={draft.timezone}
              aria-label="Time zone"
              data-setting="timezone"
              onChange={(e) => set("timezone", e.target.value)}
            />
            <datalist id="warmup-zones">
              {zones.map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Send from</span>
            <input type="time" className="pv-input" value={draft.fromTime} aria-label="Send from" data-setting="fromTime" onChange={(e) => set("fromTime", e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Send until</span>
            <input type="time" className="pv-input" value={draft.toTime} aria-label="Send until" data-setting="toTime" onChange={(e) => set("toTime", e.target.value)} />
          </label>
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Days">
          {WEEK_DAYS.map((d) => {
            const on = draft.days.includes(d);
            return (
              <button
                key={d}
                type="button"
                aria-pressed={on}
                data-day={d}
                onClick={() => toggleDay(d)}
                className={`pv-chip ${on ? "pv-chip-active" : "hover:text-foreground"}`}
              >
                {d.slice(0, 3)}
              </button>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">00:00–23:59 every day means warmup can send at any time.</p>
      </section>

      {checked && checked.problems.length > 0 && (
        <ul className="space-y-1 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning" data-problems>
          {checked.problems.map((p) => (
            <li key={p} className="flex gap-2">
              <AlertIcon size={14} className="mt-0.5 shrink-0" /> {p}
            </li>
          ))}
        </ul>
      )}
      {saveError && <p className="text-sm text-danger">{saveError}</p>}

      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
        <button type="button" className="pv-btn-primary" data-save disabled={!dirty || saving || !checked?.settings} onClick={save}>
          {saving ? <Spinner size={14} /> : null} Save settings
        </button>
        <button type="button" className="pv-btn-ghost" data-reset disabled={isDefault} onClick={() => { setJustSaved(false); setDraft(toDraft(DEFAULT_WARMUP_SETTINGS)); }}>
          Reset to defaults
        </button>
        <span className="text-xs text-muted-foreground" data-save-state>
          {justSaved
            ? "Saved — the next run uses these."
            : dirty
              ? "Unsaved changes."
              : savedAt
                ? `Saved ${new Date(savedAt).toLocaleString()}.`
                : "Using the defaults."}
        </span>
      </div>
      {checked?.settings && (
        <p className="text-xs text-muted-foreground" data-summary>
          {describeWarmup(checked.settings)}
        </p>
      )}
    </div>
  );
}
