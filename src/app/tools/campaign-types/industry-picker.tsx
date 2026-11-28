"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { findIndustry, type Industry } from "@/lib/campaign-types/industries";
import { ChevronDownIcon } from "@/components/icons";
import { Spinner } from "@/components/ui";

// The Industry field of Create All Campaign Types: a combobox. The dropdown
// lists the saved industries; typing filters them, and a name that isn't
// saved yet is offered as + Add "…", which saves it on the spot. Picking one
// fills the segment rows with the segments it used last time.

const key = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

type Item = { kind: "pick"; industry: Industry } | { kind: "add"; name: string };

export function IndustryPicker({
  industries,
  value,
  segments,
  saving,
  onType,
  onPick,
  onAdd,
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
  onAdd: (name: string) => void;
  onForget: (name: string) => void;
  onSave: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const saved = findIndustry(industries, value);

  const items = useMemo<Item[]>(() => {
    const sorted = [...industries].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    const k = key(value);
    // With a saved one in the field, show them all: it is a picker as well.
    const shown = !k || saved ? sorted : sorted.filter((i) => key(i.name).includes(k));
    const out: Item[] = shown.map((industry) => ({ kind: "pick", industry }));
    if (k && !saved) out.push({ kind: "add", name: value.replace(/\s+/g, " ").trim() });
    return out;
  }, [industries, value, saved]);

  useEffect(() => setActive(0), [value, open]);

  // Closes on a click anywhere else.
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  function choose(item: Item | undefined) {
    if (!item) return;
    if (item.kind === "pick") onPick(item.industry);
    else onAdd(item.name);
    setOpen(false);
    inputRef.current?.blur();
  }

  const same = !!saved && saved.segments.map(key).join("|") === segments.map(key).join("|");
  const canSave = !!saved && segments.length > 0 && !same;

  return (
    <div data-industry ref={wrapRef}>
      <label className="mb-1.5 block text-xs font-medium text-muted-foreground" htmlFor="ct-industry">
        Industry
      </label>
      <div className="relative">
        <input
          ref={inputRef}
          id="ct-industry"
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls="ct-industry-list"
          className="pv-input pr-9"
          placeholder="Choose or type a new one"
          value={value}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            onType(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
              setActive((a) => Math.min(a + 1, items.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (open) choose(items[active]);
            } else if (e.key === "Escape" || e.key === "Tab") {
              setOpen(false);
            }
          }}
          aria-label="Industry"
        />
        <button
          type="button"
          tabIndex={-1}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground"
          aria-label="Show saved industries"
          onClick={() => {
            setOpen((o) => !o);
            inputRef.current?.focus();
          }}
        >
          <ChevronDownIcon size={16} />
        </button>
        {open && (
          <div
            id="ct-industry-list"
            role="listbox"
            className="absolute z-20 mt-1.5 max-h-72 w-full overflow-y-auto rounded-xl border border-border bg-background p-1 shadow-soft"
            data-industry-list
          >
            {items.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">No industries saved yet — type one to add it.</p>}
            {items.map((item, idx) =>
              item.kind === "pick" ? (
                <div
                  key={item.industry.name}
                  role="option"
                  aria-selected={idx === active}
                  className={`group flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 ${idx === active ? "bg-muted" : ""}`}
                  onMouseEnter={() => setActive(idx)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(item)}
                  data-industry-option={item.industry.name}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{item.industry.name}</span>
                    {item.industry.segments.length > 0 && (
                      <span className="block truncate text-[11px] text-muted-foreground">{item.industry.segments.join(" · ")}</span>
                    )}
                  </span>
                  <button
                    type="button"
                    className="shrink-0 px-1 text-muted-foreground opacity-0 hover:text-danger group-hover:opacity-100 focus:opacity-100"
                    aria-label={`Forget ${item.industry.name}`}
                    title="Forget this industry"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (window.confirm(`Forget "${item.industry.name}" and its saved segments?`)) onForget(item.industry.name);
                    }}
                  >
                    ×
                  </button>
                </div>
              ) : (
                <div
                  key="add"
                  role="option"
                  aria-selected={idx === active}
                  className={`flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm text-accent ${idx === active ? "bg-muted" : ""}`}
                  onMouseEnter={() => setActive(idx)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(item)}
                  data-industry-add
                >
                  <span className="text-base leading-none">+</span>
                  <span className="truncate">Add &ldquo;{item.name}&rdquo;</span>
                </div>
              )
            )}
          </div>
        )}
      </div>
      <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground" data-industry-status>
        {!value.trim() ? (
          <span>Pick one to fill in its segments, or type a new one to add it.</span>
        ) : !saved ? (
          <span>Not added yet — choose + Add &ldquo;{value.trim()}&rdquo; from the list.</span>
        ) : saved.segments.length === 0 && segments.length === 0 ? (
          <span>No segments saved yet — fill them in below; they&apos;re saved when the run starts.</span>
        ) : same ? (
          <span>Saved segments: {saved.segments.join(", ")}.</span>
        ) : saved.segments.length === 0 ? (
          <span>No segments saved yet — these are saved when the run starts.</span>
        ) : (
          <span>Changed from the saved segments ({saved.segments.join(", ")}) — saved when the run starts.</span>
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
