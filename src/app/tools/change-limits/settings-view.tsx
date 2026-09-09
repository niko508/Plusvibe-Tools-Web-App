"use client";

import {
  FIELDS,
  parseSettings,
  type SettingsInput,
  type SettingsKey,
} from "@/lib/change-limits/settings";
import { AlertIcon, CheckIcon } from "@/components/icons";

// The "Increase settings" menu item: the five values applied to every inbox
// that meets the thresholds. Each one is optional — a blank field is left
// exactly as it is on the inbox.

interface Props {
  value: SettingsInput;
  onChange: (next: SettingsInput) => void;
}

export function SettingsView({ value, onChange }: Props) {
  const parsed = parseSettings(value);

  const set = (key: SettingsKey, v: string) => onChange({ ...value, [key]: v });

  return (
    <div className="space-y-5">
      <div className="pv-card p-4 sm:p-5">
        <h2 className="text-sm font-semibold">Increase settings</h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          What every qualifying inbox is set to. Leave a field blank and that
          setting is left alone on the inbox.
        </p>

        <div className="mt-5 space-y-4">
          {FIELDS.map((f) => {
            const problem = parsed.problems[f.key];
            return (
              <div
                key={f.key}
                className="grid grid-cols-1 items-start gap-2 sm:grid-cols-[minmax(0,1fr)_auto]"
              >
                <div>
                  <label
                    className="block text-sm font-medium"
                    htmlFor={`cl-${f.key}`}
                  >
                    {f.label}
                  </label>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {f.hint}{" "}
                    <span className="font-mono opacity-70">{f.apiField}</span>
                  </p>
                  {problem && (
                    <p className="mt-1 flex items-center gap-1.5 text-xs text-danger">
                      <AlertIcon size={12} />
                      {problem}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    id={`cl-${f.key}`}
                    aria-label={f.label}
                    type="number"
                    inputMode="decimal"
                    step={f.integer ? "1" : "0.1"}
                    min={f.min}
                    max={f.max}
                    placeholder="Leave as is"
                    value={value[f.key]}
                    onChange={(e) => set(f.key, e.target.value)}
                    className={`pv-input w-40 text-right tabular-nums ${
                      problem ? "border-danger" : ""
                    }`}
                  />
                  <span className="w-16 text-xs text-muted-foreground">
                    {f.unit}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-border pt-4">
          <button
            type="button"
            className="pv-btn-ghost"
            onClick={() =>
              onChange({
                campaignEmails: "",
                warmupEmails: "",
                randomize: "",
                warmupReplyRate: "",
                intervalMinutes: "",
              })
            }
          >
            Clear all
          </button>
          <span className="text-xs text-muted-foreground">
            Settings are remembered in this browser.
          </span>
        </div>
      </div>

      <div className="pv-card p-4 sm:p-5" data-settings-summary>
        <h3 className="text-sm font-semibold">What will be applied</h3>
        {parsed.summary.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Nothing yet. Fill in at least one value above — until then there is
            nothing to apply, and the Apply button stays off.
          </p>
        ) : (
          <>
            <ul className="mt-3 space-y-2">
              {parsed.summary.map((r) => (
                <li key={r.key} className="flex items-center justify-between gap-4 text-sm">
                  <span className="flex items-center gap-2">
                    <CheckIcon size={13} className="text-success" />
                    {r.label}
                  </span>
                  <span className="font-medium tabular-nums">{r.value}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-muted-foreground">
              Everything else on those inboxes is left untouched.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
