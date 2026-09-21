"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ApiClientError,
  fetchOutreachSettings,
  saveOutreachSettings,
} from "@/lib/api-client";
import { CATEGORIES, CATEGORY_LABELS, type Category } from "@/lib/start-outreach/categories";
import {
  DEFAULT_OUTREACH_SETTINGS,
  WEEKS,
  WEEK_LABELS,
  describeWeek,
  validateSettings,
  weekIsEmpty,
  type OutreachSettings,
  type Week,
} from "@/lib/start-outreach/week-settings";
import { SWITCH_HOUR, SWITCH_TIMEZONE } from "@/lib/start-outreach/schedule";
import { FIXED_ROWS, OUTREACH_FIELDS, type OutreachSettingsInput } from "@/lib/start-outreach/plan";
import { Spinner, TableDisclosure } from "@/components/ui";
import { AlertIcon, SettingsIcon } from "@/components/icons";

// The saved settings: two weeks of numbers for each kind of infrastructure.
//
// Saved on the SERVER rather than in this browser, because the week 2 switch
// reads them at six in the morning with nobody watching — a value left in
// localStorage would never reach it.

export const WEEK_NOTE = `Every batch starts on week 1. Week 2 lands seven days later at ${String(SWITCH_HOUR).padStart(2, "0")}:00 ${SWITCH_TIMEZONE.split("/")[1]} time, before any sending window opens.`;

/** The five fields of one week, as a row of boxes. */
export function WeekFields({
  value,
  onChange,
  problems,
  idPrefix,
  disabled,
}: {
  value: OutreachSettingsInput;
  onChange: (next: OutreachSettingsInput) => void;
  problems?: Partial<Record<keyof OutreachSettingsInput, string>>;
  idPrefix: string;
  disabled?: boolean;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {OUTREACH_FIELDS.map((f) => (
        <div key={f.key}>
          <label
            className="mb-1 block text-xs font-medium text-muted-foreground"
            htmlFor={`${idPrefix}-${f.key}`}
          >
            {f.label}{" "}
            <span className="font-mono text-[10px] text-muted-foreground/70">{f.apiField}</span>
          </label>
          <div className="flex items-center gap-2">
            <input
              id={`${idPrefix}-${f.key}`}
              type="number"
              min={f.min}
              max={f.max}
              step={f.integer ? 1 : 0.1}
              disabled={disabled}
              className={`pv-input w-full text-right tabular-nums ${problems?.[f.key] ? "border-danger" : ""}`}
              value={value[f.key]}
              placeholder="leave as is"
              aria-label={`${idPrefix} ${f.label}`}
              onChange={(e) => onChange({ ...value, [f.key]: e.target.value })}
            />
            <span className="w-14 shrink-0 text-xs text-muted-foreground">{f.unit}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

/** One category's two weeks, side by side down the page. */
export function CategoryWeeks({
  category,
  value,
  onChange,
  idPrefix,
  headerRight,
}: {
  category: Category;
  value: { week1: OutreachSettingsInput; week2: OutreachSettingsInput };
  onChange: (next: { week1: OutreachSettingsInput; week2: OutreachSettingsInput }) => void;
  idPrefix: string;
  headerRight?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border p-3 sm:p-4" data-category={category}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{CATEGORY_LABELS[category]}</h3>
        {headerRight}
      </div>
      <div className="space-y-4">
        {WEEKS.map((w: Week) => {
          const key = w === 1 ? "week1" : "week2";
          const input = value[key];
          return (
            <div key={w}>
              <div className="mb-1.5 flex flex-wrap items-baseline gap-2">
                <span className="text-xs font-medium">{WEEK_LABELS[w]}</span>
                <span className="text-[11px] text-muted-foreground">
                  {w === 1 ? "applied when the batch runs" : "applied seven days later"}
                  {weekIsEmpty(input) && (
                    <span className="text-warning"> · every field blank, so nothing would change</span>
                  )}
                </span>
              </div>
              <WeekFields
                value={input}
                idPrefix={`${idPrefix}-${category}-w${w}`}
                onChange={(next) => onChange({ ...value, [key]: next })}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground" data-fixed-settings>
        {FIXED_ROWS.map((r) => (
          <span key={r.key} className="pv-chip" title={r.apiField}>
            {r.label} <span className="ml-1 font-medium">{r.value}</span>
          </span>
        ))}
        <span>Blank fields are left as they are.</span>
      </div>
    </div>
  );
}

/**
 * The standalone Settings section.
 *
 * Folded away by default: it is set once and then left alone for weeks, and
 * open it would push the domain list off the screen every time the page loads.
 */
export function OutreachSettingsPanel({ onSaved }: { onSaved?: (s: OutreachSettings) => void }) {
  const [settings, setSettings] = useState<OutreachSettings>(DEFAULT_OUTREACH_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    try {
      const { settings: s } = await fetchOutreachSettings();
      setSettings(s);
      setDirty(false);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof ApiClientError || err instanceof Error ? err.message : "Could not read the settings.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 4000);
    return () => clearTimeout(t);
  }, [note]);

  const problems = validateSettings(settings);

  async function save() {
    if (saving || problems.length > 0) return;
    setSaving(true);
    setError(null);
    try {
      const { settings: s } = await saveOutreachSettings(settings);
      setSettings(s);
      setDirty(false);
      setNote("Saved — every new batch starts from these.");
      onSaved?.(s);
    } catch (err) {
      setError(err instanceof ApiClientError || err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  const update = (c: Category, next: { week1: OutreachSettingsInput; week2: OutreachSettingsInput }) => {
    setSettings((s) => ({ ...s, [c]: next }));
    setDirty(true);
  };

  return (
    <div className="pv-card space-y-3 p-4 sm:p-5" data-outreach-settings>
      <TableDisclosure
        open={open}
        onToggle={() => setOpen((v) => !v)}
        label="Settings · week 1 and week 2 for each kind of inbox"
      >
        <div className="space-y-4 p-3 sm:p-4">
          <p className="text-xs text-muted-foreground">{WEEK_NOTE}</p>

          {!loaded ? (
            <div className="h-24 animate-pulse rounded-xl bg-muted" />
          ) : (
            CATEGORIES.map((c) => (
              <CategoryWeeks
                key={c}
                category={c}
                value={settings[c]}
                idPrefix="saved"
                onChange={(next) => update(c, next)}
              />
            ))
          )}

          {problems.length > 0 && (
            <div className="space-y-1">
              {problems.slice(0, 4).map((p) => (
                <p key={p} className="text-xs text-danger">
                  {p}
                </p>
              ))}
            </div>
          )}
          {error && (
            <p className="flex gap-1.5 text-xs text-danger">
              <AlertIcon size={13} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="pv-btn-primary text-xs disabled:opacity-50"
              disabled={!loaded || saving || problems.length > 0 || !dirty}
              onClick={save}
              data-save-outreach-settings
            >
              {saving ? <Spinner size={13} /> : <SettingsIcon size={13} />}
              Save settings
            </button>
            {note ? (
              <span className="text-xs text-success">{note}</span>
            ) : dirty ? (
              <span className="text-xs text-muted-foreground">Not saved yet.</span>
            ) : (
              <span className="text-xs text-muted-foreground">
                {CATEGORY_LABELS.google} week 1: {describeWeek(settings.google.week1)}
              </span>
            )}
          </div>
        </div>
      </TableDisclosure>
    </div>
  );
}
