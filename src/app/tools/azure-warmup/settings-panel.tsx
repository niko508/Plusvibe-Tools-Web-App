"use client";

// The Warmup settings tab. Laid out and worded like Plusvibe's own warmup
// settings page — Basic, then Advanced, a switch on the right of each setting
// — so every setting here reads as the one it sets there.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { getAzureWarmupSettings, saveAzureWarmupSettings } from "@/lib/api-client";
import {
  BUSINESS_TYPES,
  DEFAULT_WARMUP_SETTINGS,
  MAX_SIGNATURE_LENGTH,
  WARMUP_LIMITS,
  WEEKDAYS,
  WEEK_DAYS,
  describeWarmup,
  validateWarmupSettings,
  type WarmupSettings,
} from "@/lib/azure-warmup/warmup-settings";
import { Spinner } from "@/components/ui";
import { AlertIcon } from "@/components/icons";

/** What the form holds: numbers as typed, so a half-typed field isn't forced to 0. */
type NumKey = "initialDailyLimit" | "paceIncrement" | "maxDailyLimit" | "randomizeNum" | "replyRatePct";
type Draft = Omit<WarmupSettings, NumKey> & Record<NumKey, string>;

const toDraft = (s: WarmupSettings): Draft => ({
  ...s,
  initialDailyLimit: String(s.initialDailyLimit),
  paceIncrement: String(s.paceIncrement),
  maxDailyLimit: String(s.maxDailyLimit),
  randomizeNum: String(s.randomizeNum),
  replyRatePct: String(s.replyRatePct),
});

const same = (a: WarmupSettings, b: WarmupSettings) => JSON.stringify(a) === JSON.stringify(b);

/** "(UTC +08:00)" for a zone, as Plusvibe labels its time zones. */
function utcLabel(zone: string): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value;
    const m = /GMT([+-]\d{2}:\d{2})?/.exec(part ?? "");
    const offset = m?.[1] ?? "+00:00";
    return `(UTC ${offset})`;
  } catch {
    return "";
  }
}

/** Every IANA zone the browser knows. */
function timeZones(current: string): string[] {
  let list: string[] = [];
  try {
    list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    // older browser: fall back to a short list
  }
  if (list.length === 0) list = ["UTC", "Asia/Singapore", "Europe/Helsinki", "Europe/London", "America/New_York", "America/Los_Angeles"];
  return list.includes(current) ? list : [current, ...list];
}

// --- building blocks, shaped like Plusvibe's --------------------------------------

function Switch({ on, onChange, label, id }: { on: boolean; onChange: (v: boolean) => void; label: string; id: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      data-setting={id}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
        on ? "bg-accent" : "bg-muted-foreground/30"
      }`}
    >
      <span
        className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${on ? "translate-x-[22px]" : "translate-x-0.5"}`}
      />
    </button>
  );
}

/** A setting: its name and what it does on the left, its control on the right. */
function Row({ title, description, control, children }: { title: string; description?: ReactNode; control?: ReactNode; children?: ReactNode }) {
  return (
    <div className="space-y-3 py-4 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="text-sm font-medium">{title}</div>
          {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
        </div>
        {control}
      </div>
      {children}
    </div>
  );
}

function Slider({
  id,
  label,
  value,
  min,
  max,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  min: number;
  max: number;
  onChange: (v: string) => void;
}) {
  const n = Number(value);
  return (
    <div className="flex max-w-xl items-center gap-4">
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={Number.isFinite(n) ? n : min}
        aria-label={label}
        data-setting={id}
        onChange={(e) => onChange(e.target.value)}
        className="h-1.5 flex-1 cursor-pointer accent-[hsl(var(--accent))]"
      />
      <span className="w-12 text-right text-sm font-medium tabular-nums" data-value={id}>
        {value}%
      </span>
    </div>
  );
}

function NumberField({ id, label, value, min, max, onChange }: { id: NumKey; label: string; value: string; min: number; max: number; onChange: (v: string) => void }) {
  return (
    <input
      type="number"
      inputMode="numeric"
      className="pv-input w-40 tabular-nums"
      min={min}
      max={max}
      value={value}
      aria-label={label}
      data-setting={id}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

// --- the tab -----------------------------------------------------------------------

export function WarmupSettingsPanel({ onSaved }: { onSaved?: (s: WarmupSettings) => void }) {
  const [saved, setSaved] = useState<WarmupSettings | null>(null);
  const [savedAt, setSavedAt] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

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

  const zones = useMemo(() => (draft ? timeZones(draft.timezone) : []), [draft?.timezone]); // eslint-disable-line react-hooks/exhaustive-deps
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
  // Plusvibe offers a schedule of weekdays or every day; so does this.
  const weekdaysOnly = draft.days.length === 5 && WEEKDAYS.every((d) => draft.days.includes(d));

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

  return (
    <div className="space-y-5" data-warmup-settings>
      <p className="text-sm text-muted-foreground">
        These are Plusvibe&apos;s warmup settings, applied to every inbox a run starts warming. A run takes a copy when it
        starts, so changes here apply to the next run — runs already going keep the settings they started with.
      </p>

      {/* Basic Warmup Settings */}
      <div className="pv-card p-4 sm:p-6">
        <h2 className="mb-4 text-base font-semibold">Basic Warmup Settings</h2>
        <div className="divide-y divide-border">
          <Row title="Daily Warmup Limit">
            <div>
              <NumberField
                id="maxDailyLimit"
                label="Daily Warmup Limit"
                value={draft.maxDailyLimit}
                min={L.dailyLimit.min}
                max={L.dailyLimit.max}
                onChange={(v) => set("maxDailyLimit", v)}
              />
              <p className="mt-1 text-xs text-muted-foreground">Max limit: {L.dailyLimit.max} Emails</p>
            </div>
          </Row>
          <Row
            title="Warmup Email Ramp-Up"
            description="Gradually increase daily warmup email sends until the maximum limit is reached."
            control={<Switch id="slowRampup" label="Warmup Email Ramp-Up" on={draft.slowRampup} onChange={(v) => set("slowRampup", v)} />}
          >
            {draft.slowRampup && (
              <div className="grid gap-4 sm:grid-cols-2" data-rampup>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium">Starting daily limit</span>
                  <NumberField
                    id="initialDailyLimit"
                    label="Starting daily limit"
                    value={draft.initialDailyLimit}
                    min={L.dailyLimit.min}
                    max={L.dailyLimit.max}
                    onChange={(v) => set("initialDailyLimit", v)}
                  />
                  <span className="mt-1 block text-xs text-muted-foreground">Warmup emails sent on the first day.</span>
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium">Daily increase</span>
                  <NumberField
                    id="paceIncrement"
                    label="Daily increase"
                    value={draft.paceIncrement}
                    min={L.paceIncrement.min}
                    max={L.paceIncrement.max}
                    onChange={(v) => set("paceIncrement", v)}
                  />
                  <span className="mt-1 block text-xs text-muted-foreground">Added each day until the Daily Warmup Limit is reached.</span>
                </label>
              </div>
            )}
          </Row>
        </div>
      </div>

      {/* Advanced Warmup Settings */}
      <div className="overflow-hidden rounded-2xl border border-warning/30 bg-warning/[0.04]">
        <div className="border-b border-warning/30 bg-warning/10 px-4 py-4 sm:px-6">
          <h2 className="text-base font-semibold">Advanced Warmup Settings</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Sending warmup emails during weekday office hours in the lead&apos;s timezone, with content including keywords
            relevant to your business industry are crucial steps to ensure optimal email deliverability.
          </p>
        </div>
        <div className="divide-y divide-border px-4 py-5 sm:px-6">
          <Row
            title="Randomized Warm-Up Limit"
            description="Randomizes the daily limit to make sending patterns appear more natural. Enter a percentage to set how much it can vary (e.g. 20% means it will randomly range between 80-100% of your maximum limit)."
            control={<Switch id="randomize" label="Randomized Warm-Up Limit" on={draft.randomize} onChange={(v) => set("randomize", v)} />}
          >
            {draft.randomize && (
              <div>
                <div className="mb-2 text-xs font-medium">Range in %</div>
                <Slider
                  id="randomizeNum"
                  label="Range in %"
                  value={draft.randomizeNum}
                  min={L.randomizeNum.min}
                  max={L.randomizeNum.max}
                  onChange={(v) => set("randomizeNum", v)}
                />
              </div>
            )}
          </Row>

          <Row
            title="Business Type"
            description="Choose the business type that closely matches the emails you'll send to leads. You can leave it empty for generic business-type emails."
          >
            <select
              className="pv-input"
              value={draft.businessType}
              aria-label="Business Type"
              data-setting="businessType"
              onChange={(e) => set("businessType", e.target.value)}
            >
              <option value="">Generic Business Type</option>
              {BUSINESS_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Row>

          <Row
            title="Warmup Schedule"
            description="Select the warmup schedule that best matches when you plan to email your leads. Outgoing warmup replies may be sent outside of this schedule, since real human replies can happen at any time."
          >
            <div className="space-y-4">
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium">Timezone</span>
                <select
                  className="pv-input"
                  value={draft.timezone}
                  aria-label="Timezone"
                  data-setting="timezone"
                  onChange={(e) => set("timezone", e.target.value)}
                >
                  {zones.map((z) => (
                    <option key={z} value={z}>
                      {z} {utcLabel(z)}
                    </option>
                  ))}
                </select>
              </label>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium">Start time</span>
                  <input type="time" className="pv-input" value={draft.fromTime} aria-label="Start time" data-setting="fromTime" onChange={(e) => set("fromTime", e.target.value)} />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium">End time</span>
                  <input type="time" className="pv-input" value={draft.toTime} aria-label="End time" data-setting="toTime" onChange={(e) => set("toTime", e.target.value)} />
                </label>
              </div>
              <p className="text-xs text-muted-foreground">00:00 to 23:59 means any time of day.</p>
            </div>
          </Row>

          <Row
            title="Weekdays only"
            control={
              <Switch
                id="weekdaysOnly"
                label="Weekdays only"
                on={weekdaysOnly}
                onChange={(v) => set("days", v ? [...WEEKDAYS] : [...WEEK_DAYS])}
              />
            }
          />

          <Row
            title="Warmup Signature"
            description="Include your signature in warm-up emails."
            control={<Switch id="warmupSignature" label="Warmup Signature" on={draft.warmupSignature} onChange={(v) => set("warmupSignature", v)} />}
          />

          <Row
            title="Warmup Reply Rate"
            description="Increase your warm-up reply rate when email deliverability decreases. Recommended value: 35%"
          >
            <Slider
              id="replyRatePct"
              label="Warmup Reply Rate"
              value={draft.replyRatePct}
              min={L.replyRatePct.min}
              max={L.replyRatePct.max}
              onChange={(v) => set("replyRatePct", v)}
            />
          </Row>
        </div>
      </div>

      {/* Email Signature */}
      <div className="pv-card p-4 sm:p-6">
        <h2 className="text-base font-semibold">Email Signature</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Use {"{{sender_first_name}}"} and {"{{sender_last_name}}"} placeholders to dynamically display the sender&apos;s first
          and last names. To include this signature in your campaign emails, insert the {"{{sender_signature}}"} placeholder in
          the sequence editor. Spintax is also supported here.
        </p>
        <textarea
          className="pv-input mt-4 min-h-[110px] font-mono text-sm"
          value={draft.signature}
          maxLength={MAX_SIGNATURE_LENGTH}
          aria-label="Email Signature"
          data-setting="signature"
          placeholder="Leave empty to keep each inbox's own signature"
          onChange={(e) => set("signature", e.target.value)}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Set on every inbox a run starts. A new line becomes a line break. Leave it empty to keep each inbox&apos;s own
          signature.
        </p>
      </div>

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

      <div className="pv-card sticky bottom-4 z-10 flex flex-wrap items-center gap-3 p-4 shadow-lg">
        <button type="button" className="pv-btn-primary" data-save disabled={!dirty || saving || !checked?.settings} onClick={save}>
          {saving ? <Spinner size={14} /> : null} Save settings
        </button>
        <button
          type="button"
          className="pv-btn-ghost"
          data-reset
          disabled={isDefault}
          onClick={() => {
            setJustSaved(false);
            setDraft(toDraft(DEFAULT_WARMUP_SETTINGS));
          }}
        >
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
        {checked?.settings && (
          <span className="w-full text-xs text-muted-foreground" data-summary>
            {describeWarmup(checked.settings)}
          </span>
        )}
      </div>
    </div>
  );
}
