"use client";

import { useMemo, useRef, useState } from "react";
import { findIndustry, type Industry } from "@/lib/campaign-types/industries";
import { ChevronDownIcon } from "@/components/icons";
import { Spinner } from "@/components/ui";

// The Industry field of Create All Campaign Types: type a new one, or pick a
// saved one to fill the segment rows with the segments it used last time.

const key = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export function IndustryPicker({
  industries,
  value,
  segments,
  saving,
  onType,
  onPick,
  onForget,
  onSave,
}: {
  industries: Industry[];
  value: string;
  /** The segments in the rows now, to compare with what is saved. */
  segments: string[];
  saving: boolean;
  onType: (name: string) => void;
  onPick: (industry: Industry) => void;
  onForget: (name: string) => void;
  onSave: () => void;
}) {
  const [open, setOpen] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saved = findIndustry(industries, value);
  const filtered = useMemo(() => {
    const k = key(value);
    // Once a saved one is picked, show them all again: the field is a picker too.
    if (!k || saved) return industries;
    return industries.filter((i) => key(i.name).includes(k));
  }, [industries, value, saved]);

  const same = !!saved && saved.segments.map(key).join("|") === segments.map(key).join("|");
  const canSave = value.trim() !== "" && segments.length > 0 && !same;

  function pick(i: Industry) {
    onPick(i);
    setOpen(false);
  }

  return (
    <div data-industry>
      <label className="mb-1.5 block text-xs font-medium text-muted-foreground" htmlFor="ct-industry">
        Industry
      </label>
      <div className="relative">
        <input
          id="ct-industry"
          type="text"
          className="pv-input pr-9"
          placeholder={industries.length > 0 ? "Pick a saved industry, or type a new one" : "Type an industry"}
          value={value}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            onType(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            blurTimer.current = setTimeout(() => setOpen(false), 150);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
            if (e.key === "Enter") {
              e.preventDefault();
              const exact = findIndustry(industries, value);
              const only = filtered.length === 1 ? filtered[0] : undefined;
              if (exact ?? only) pick((exact ?? only)!);
              else setOpen(false);
            }
          }}
          aria-label="Industry"
        />
        <button
          type="button"
          tabIndex={-1}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground"
          aria-label="Show saved industries"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOpen((o) => !o)}
        >
          <ChevronDownIcon size={16} />
        </button>
        {open && filtered.length > 0 && (
          <div
            className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-xl border border-border bg-background shadow-soft"
            data-industry-list
            onMouseDown={(e) => e.preventDefault()}
          >
            {filtered.map((i) => (
              <div key={i.name} className="flex items-center gap-2 border-b border-border/60 px-3 py-2 last:border-b-0 hover:bg-muted/50">
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => pick(i)} data-industry-option={i.name}>
                  <span className="block truncate text-sm">{i.name}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">{i.segments.join(" · ")}</span>
                </button>
                <button
                  type="button"
                  className="shrink-0 px-1 text-muted-foreground hover:text-danger"
                  aria-label={`Forget ${i.name}`}
                  title="Forget this industry"
                  onClick={() => {
                    if (window.confirm(`Forget "${i.name}" and its saved segments?`)) onForget(i.name);
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground" data-industry-status>
        {!value.trim() ? (
          <span>Pick one to fill in its segments. A run started under an industry saves the segments it used.</span>
        ) : saved && same ? (
          <span>Saved segments: {saved.segments.join(", ")}.</span>
        ) : saved ? (
          <span>Changed from the saved segments ({saved.segments.join(", ")}) — saved when the run starts.</span>
        ) : segments.length > 0 ? (
          <span>New industry — its segments are saved when the run starts.</span>
        ) : (
          <span>New industry — fill in its segments below.</span>
        )}
        {canSave && (
          <button type="button" className="underline hover:text-foreground disabled:opacity-50" disabled={saving} onClick={onSave} data-industry-save>
            {saving ? <Spinner size={10} /> : "Save now"}
          </button>
        )}
      </p>
    </div>
  );
}
