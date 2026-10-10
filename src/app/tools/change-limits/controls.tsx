"use client";

import type { Workspace } from "@/lib/plusvibe-types";
import { DATE_PRESETS, formatNumber } from "@/lib/format";
import { ChevronDownIcon, RefreshIcon, AlertIcon } from "@/components/icons";
import { Spinner } from "@/components/ui";
import type { ThresholdsInput } from "@/lib/change-limits/qualify";

// Nothing is fetched until Fetch inboxes is pressed: the workspaces are
// listed so there is something to pick, and the thresholds are set first so
// the results come back already judged.

interface Props {
  workspaces: Workspace[];
  workspacesLoading: boolean;
  selected: string[];
  onSelectedChange: (ids: string[]) => void;
  scopeOpen: boolean;
  onToggleScope: () => void;

  start: string;
  end: string;
  activePreset: string | null;
  onPreset: (key: string) => void;
  onStartChange: (v: string) => void;
  onEndChange: (v: string) => void;
  rangeProblem: string | null;

  thresholds: ThresholdsInput;
  onThresholdsChange: (t: ThresholdsInput) => void;
  thresholdProblems: string[];

  onFetch: () => void;
  onCancel: () => void;
  busy: boolean;
  phase: string;
}

export function Controls(props: Props) {
  const t = props.thresholds;
  const set = (patch: Partial<ThresholdsInput>) =>
    props.onThresholdsChange({ ...t, ...patch });

  return (
    <div className="pv-card space-y-4 p-4 sm:p-5">
      {/* Thresholds */}
      <div>
        <h2 className="text-sm font-semibold">Thresholds</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          True reply rate is replies ÷ unique leads contacted, worked out here
          from the counts. An inbox qualifies when it is at or above its
          provider&apos;s rate and has sent at least the minimum.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <RateField
            label="Google true reply %"
            value={t.google}
            onChange={(v) => set({ google: v })}
          />
          <RateField
            label="Microsoft true reply %"
            value={t.microsoft}
            onChange={(v) => set({ microsoft: v })}
          />
          <RateField
            label="Other providers true reply %"
            value={t.other}
            placeholder="Skip"
            onChange={(v) => set({ other: v })}
            hint="Blank leaves anything that is neither Google nor Microsoft out."
          />
          <RateField
            label="Minimum sends"
            value={t.minSends}
            step="1"
            onChange={(v) => set({ minSends: v })}
            hint="Emails sent in the range, so a quiet inbox can't qualify on one reply."
          />
        </div>
        {props.thresholdProblems.length > 0 && (
          <ul className="mt-2 space-y-1">
            {props.thresholdProblems.map((p) => (
              <li key={p} className="flex items-center gap-1.5 text-xs text-danger">
                <AlertIcon size={12} />
                {p}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Scope + range */}
      <div className="flex flex-col gap-4 border-t border-border pt-4 lg:flex-row lg:flex-wrap lg:items-end">
        <div className="min-w-[260px] flex-1">
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
            Workspaces
          </label>
          <ScopeSelector
            workspaces={props.workspaces}
            loading={props.workspacesLoading}
            selected={props.selected}
            onChange={props.onSelectedChange}
            open={props.scopeOpen}
            onToggleOpen={props.onToggleScope}
          />
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">From</label>
          <input
            type="date"
            className="pv-input"
            value={props.start}
            max={props.end}
            onChange={(e) => props.onStartChange(e.target.value)}
            aria-label="From date"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">To</label>
          <input
            type="date"
            className="pv-input"
            value={props.end}
            min={props.start}
            onChange={(e) => props.onEndChange(e.target.value)}
            aria-label="To date"
          />
        </div>
        <div className="flex gap-2">
          {props.busy && (
            <button type="button" className="pv-btn-ghost" onClick={props.onCancel}>
              Cancel
            </button>
          )}
          <button
            type="button"
            className="pv-btn-primary disabled:opacity-50"
            onClick={props.onFetch}
            disabled={
              props.busy ||
              props.selected.length === 0 ||
              !!props.rangeProblem ||
              props.thresholdProblems.length > 0
            }
            title="Lists the inboxes in the chosen workspaces, then fetches their figures 100 at a time."
          >
            {props.busy ? <Spinner /> : <RefreshIcon size={16} />}
            {props.busy ? props.phase || "Fetching…" : "Fetch inboxes"}
          </button>
        </div>
      </div>

      {props.rangeProblem && <p className="text-xs text-danger">{props.rangeProblem}</p>}

      <div className="flex flex-wrap gap-2 border-t border-border pt-4">
        {DATE_PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => props.onPreset(p.key)}
            className={`pv-chip ${
              props.activePreset === p.key ? "pv-chip-active" : "hover:text-foreground"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function RateField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  step = "0.1",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  step?: string;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <input
        type="number"
        min="0"
        step={step}
        className="pv-input text-right tabular-nums"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
      />
      {hint && <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ScopeSelector({
  workspaces,
  loading,
  selected,
  onChange,
  open,
  onToggleOpen,
}: {
  workspaces: Workspace[];
  loading: boolean;
  selected: string[];
  onChange: (ids: string[]) => void;
  open: boolean;
  onToggleOpen: () => void;
}) {
  const all = workspaces.length > 0 && selected.length === workspaces.length;
  const summary = loading
    ? "Loading workspaces…"
    : workspaces.length === 0
      ? "No workspaces found"
      : all
        ? `All workspaces (${workspaces.length})`
        : `${formatNumber(selected.length)} of ${formatNumber(workspaces.length)} workspaces`;

  function toggle(id: string) {
    onChange(
      selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]
    );
  }

  return (
    <div className="rounded-xl border border-border">
      <button
        type="button"
        onClick={onToggleOpen}
        className="flex w-full items-center justify-between px-3.5 py-2.5 text-sm"
        aria-label="Workspace scope"
      >
        <span className="font-medium">{summary}</span>
        <ChevronDownIcon
          size={16}
          className={`text-muted-foreground transition ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && !loading && (
        <div className="border-t border-border p-2">
          <div className="mb-2 flex gap-2 px-1.5">
            <button
              type="button"
              className="text-xs text-accent hover:underline"
              onClick={() => onChange(workspaces.map((w) => w._id))}
            >
              Select all
            </button>
            <button
              type="button"
              className="text-xs text-muted-foreground hover:underline"
              onClick={() => onChange([])}
            >
              Clear
            </button>
          </div>
          <div className="pv-scroll max-h-48 space-y-0.5 overflow-y-auto">
            {workspaces.map((w) => (
              <label
                key={w._id}
                className="flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1.5 text-sm hover:bg-muted"
              >
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={selected.includes(w._id)}
                  onChange={() => toggle(w._id)}
                />
                {w.name}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
