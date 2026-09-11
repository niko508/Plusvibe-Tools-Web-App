"use client";

import { useState } from "react";
import {
  FIELDS,
  SCOPE_LABELS,
  bundleBlocks,
  parseSettings,
  type SettingsBundle,
  type SettingsInput,
  type SettingsKey,
} from "@/lib/change-limits/settings";
import type { ProviderBucket } from "@/lib/plusvibe-providers";
import { AlertIcon, CheckIcon } from "@/components/icons";

// The "Increase settings" menu item: the five values applied to every inbox
// that meets the thresholds. Each one is optional — a blank field is left
// exactly as it is on the inbox.
//
// Google and Microsoft senders usually want different ceilings, so each
// provider can carry its own five values. One shared set stays the default,
// because that is the common case and switching is one click away.

const PROVIDER_TABS: ProviderBucket[] = ["google", "microsoft", "other"];

interface Props {
  value: SettingsBundle;
  onChange: (next: SettingsBundle) => void;
}

export function SettingsView({ value, onChange }: Props) {
  const [tab, setTab] = useState<ProviderBucket>("google");
  const scope: ProviderBucket | "all" = value.sameForAll ? "all" : tab;
  const current: SettingsInput = value.sameForAll ? value.all : value[tab];
  const parsed = parseSettings(current);
  const blocks = bundleBlocks(value);

  const set = (key: SettingsKey, v: string) => {
    const next = { ...current, [key]: v };
    onChange(value.sameForAll ? { ...value, all: next } : { ...value, [tab]: next });
  };

  function toggleSameForAll(same: boolean) {
    if (same) {
      onChange({ ...value, sameForAll: true });
      return;
    }
    // Splitting seeds each provider from the shared set, so nothing typed is
    // lost and the two only diverge where they are actually changed.
    const seeded = (existing: SettingsInput) =>
      hasAny(existing) ? existing : { ...value.all };
    onChange({
      ...value,
      sameForAll: false,
      google: seeded(value.google),
      microsoft: seeded(value.microsoft),
      other: seeded(value.other),
    });
  }

  return (
    <div className="space-y-5">
      <div className="pv-card p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Increase settings</h2>
            <p className="mt-1.5 text-sm text-muted-foreground">
              What every qualifying inbox is set to. Leave a field blank and
              that setting is left alone on the inbox.
            </p>
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="accent-accent"
              checked={value.sameForAll}
              aria-label="Same settings for every provider"
              onChange={(e) => toggleSameForAll(e.target.checked)}
            />
            Same for every provider
          </label>
        </div>

        {!value.sameForAll && (
          <div
            role="tablist"
            aria-label="Sender provider"
            className="mt-4 inline-flex rounded-xl border border-border p-1"
          >
            {PROVIDER_TABS.map((p) => {
              const active = p === tab;
              const count = parseSettings(value[p]).count;
              return (
                <button
                  key={p}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setTab(p)}
                  className={`rounded-lg px-3 py-1.5 text-sm transition ${
                    active
                      ? "bg-accent/10 font-medium text-accent"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {SCOPE_LABELS[p]}
                  {count > 0 && (
                    <span className="ml-1.5 tabular-nums opacity-60">{count}</span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        <p className="mt-3 text-xs text-muted-foreground" data-scope-note>
          {value.sameForAll
            ? "One set of values for Google, Microsoft and everything else."
            : `These values apply to ${SCOPE_LABELS[tab]} only.`}
        </p>

        <div className="mt-4 space-y-4">
          {FIELDS.map((f) => {
            const problem = parsed.problems[f.key];
            return (
              <div
                key={f.key}
                className="grid grid-cols-1 items-start gap-2 sm:grid-cols-[minmax(0,1fr)_auto]"
              >
                <div>
                  <label className="block text-sm font-medium" htmlFor={`cl-${f.key}`}>
                    {f.label}
                  </label>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {f.hint} <span className="font-mono opacity-70">{f.apiField}</span>
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
                    // The scope is in the label so a test — and a screen
                    // reader — can tell the three sets apart.
                    aria-label={`${f.label} (${SCOPE_LABELS[scope]})`}
                    type="number"
                    inputMode="decimal"
                    step={f.integer ? "1" : "0.1"}
                    min={f.min}
                    max={f.max}
                    placeholder="Leave as is"
                    value={current[f.key]}
                    onChange={(e) => set(f.key, e.target.value)}
                    className={`pv-input w-40 text-right tabular-nums ${
                      problem ? "border-danger" : ""
                    }`}
                  />
                  <span className="w-16 text-xs text-muted-foreground">{f.unit}</span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-border pt-4">
          <button
            type="button"
            className="pv-btn-ghost"
            onClick={() => {
              const blank: SettingsInput = {
                campaignEmails: "",
                warmupEmails: "",
                randomize: "",
                warmupReplyRate: "",
                intervalMinutes: "",
              };
              onChange(
                value.sameForAll
                  ? { ...value, all: blank }
                  : { ...value, [tab]: blank }
              );
            }}
          >
            {value.sameForAll ? "Clear all" : `Clear ${SCOPE_LABELS[tab]}`}
          </button>
          <span className="text-xs text-muted-foreground">
            Settings are remembered in this browser.
          </span>
        </div>
      </div>

      <div className="pv-card p-4 sm:p-5" data-settings-summary>
        <h3 className="text-sm font-semibold">What will be applied</h3>
        {blocks.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Nothing yet. Fill in at least one value above — until then there is
            nothing to apply, and the Apply button stays off.
          </p>
        ) : (
          <>
            <div className="mt-3 space-y-4">
              {blocks.map((block) => (
                <div key={block.scope}>
                  <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {block.label}
                  </h4>
                  <ul className="mt-2 space-y-2">
                    {block.rows.map((r) => (
                      <li
                        key={r.key}
                        className="flex items-center justify-between gap-4 text-sm"
                      >
                        <span className="flex items-center gap-2">
                          <CheckIcon size={13} className="text-success" />
                          {r.label}
                        </span>
                        <span className="font-medium tabular-nums">{r.value}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            {!value.sameForAll && blocks.length < PROVIDER_TABS.length && (
              <p className="mt-3 text-xs text-warning" data-unset-note>
                {PROVIDER_TABS.filter((p) => !blocks.some((b) => b.scope === p))
                  .map((p) => SCOPE_LABELS[p])
                  .join(" and ")}{" "}
                have nothing set, so those inboxes are left untouched even when
                they qualify.
              </p>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              Everything else on those inboxes is left untouched.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function hasAny(input: SettingsInput): boolean {
  return FIELDS.some((f) => (input[f.key] ?? "").trim() !== "");
}
