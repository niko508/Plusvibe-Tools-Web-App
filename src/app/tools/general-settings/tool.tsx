"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_GENERAL_SETTINGS,
  SECTIONS,
  setGeneralSettings,
  spintaxOptions,
  type FieldDef,
  type GeneralSettings,
  type SectionDef,
} from "@/lib/general-settings/settings";
import { fetchGeneralSettings, saveGeneralSettings, ApiClientError } from "@/lib/api-client";
import { readTagSets } from "@/lib/tags/domain-tags";
import { normalizeColor, tagKey, type TagInput } from "@/lib/tags/bulk-tags";
import { useApiKey } from "@/lib/use-api-key";
import { formatNumber } from "@/lib/format";
import { ConnectPrompt } from "@/components/connect-prompt";
import { Spinner } from "@/components/ui";
import { AlertIcon, CheckIcon, TrashIcon } from "@/components/icons";

// The General Settings page. Everything on it is drawn from SECTIONS in
// src/lib/general-settings/settings.ts — a new setting added there shows up
// here with its editor, its reset and its validation, with nothing to change
// in this file.

type Draft = Record<string, Record<string, unknown>>;

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const DEFAULTS = DEFAULT_GENERAL_SETTINGS as unknown as Draft;

/** The TLD and platform lists Bulk Actions used to keep in this browser. */
const OLD_TAG_SETS_KEY = "pv_domain_tag_sets";

function errMessage(err: unknown): string {
  if (err instanceof ApiClientError || err instanceof Error) return err.message;
  return "Something went wrong.";
}

export function GeneralSettingsTool() {
  const { hasKey, ready } = useApiKey();
  const [saved, setSaved] = useState<Draft | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [updatedAt, setUpdatedAt] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [browserSets, setBrowserSets] = useState<{ tld: TagInput[]; platform: TagInput[] } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetchGeneralSettings();
      setSaved(clone(r.settings) as unknown as Draft);
      setDraft(clone(r.settings) as unknown as Draft);
      setUpdatedAt(r.updatedAt);
      setGeneralSettings(r.settings, r.updatedAt);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (ready && hasKey) void load();
  }, [ready, hasKey, load]);

  // Lists saved in this browser before General Settings existed: offered once,
  // until settings have been saved, when they differ from what is here.
  useEffect(() => {
    try {
      setBrowserSets(readTagSets(window.localStorage.getItem(OLD_TAG_SETS_KEY)));
    } catch {
      setBrowserSets(null);
    }
  }, []);

  // Jump to #tags and the like once the sections are on the page.
  useEffect(() => {
    if (!draft || !window.location.hash) return;
    document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ block: "start" });
    // Only on the first load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!draft]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const dirty = !!draft && !!saved && !same(draft, saved);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const setField = useCallback((section: string, key: string, value: unknown) => {
    setDraft((d) => (d ? { ...d, [section]: { ...d[section], [key]: value } } : d));
    setProblems([]);
  }, []);

  async function save() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    setProblems([]);
    try {
      const r = await saveGeneralSettings(draft as unknown as GeneralSettings);
      setSaved(clone(r.settings) as unknown as Draft);
      setDraft(clone(r.settings) as unknown as Draft);
      setUpdatedAt(r.updatedAt);
      setGeneralSettings(r.settings, r.updatedAt);
      setToast("Saved — every tool uses these from now on.");
    } catch (err) {
      setError(errMessage(err));
      if (err instanceof ApiClientError) {
        // The server names each problem; show them as a list, not one long line.
        setProblems(err.message.split(/(?<=\.)\s+(?=[A-Z])/).filter(Boolean));
      }
    } finally {
      setSaving(false);
    }
  }

  const offerBrowserSets =
    !!browserSets &&
    !!draft &&
    updatedAt === 0 &&
    (!same(browserSets.tld.map((t) => tagKey(t.name)), (draft.tags.tld as TagInput[]).map((t) => tagKey(t.name))) ||
      !same(browserSets.platform.map((t) => tagKey(t.name)), (draft.tags.platform as TagInput[]).map((t) => tagKey(t.name))));

  if (!ready) return <div className="pv-card h-40 animate-pulse" />;
  if (!hasKey) return <ConnectPrompt onConnected={load} />;

  return (
    <div className="space-y-5 pb-20">
      <nav className="flex flex-wrap gap-2">
        {SECTIONS.map((s) => (
          <a key={s.key} href={`#${s.key}`} className="pv-chip hover:border-accent/40">
            {s.title}
          </a>
        ))}
      </nav>

      {error && problems.length === 0 && (
        <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          <AlertIcon size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {problems.length > 0 && (
        <div className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          <p className="mb-1 font-medium">Nothing was saved:</p>
          <ul className="list-disc space-y-0.5 pl-5">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      {loading && !draft && (
        <div className="pv-card flex items-center gap-2 p-5 text-sm text-muted-foreground">
          <Spinner /> Loading settings…
        </div>
      )}

      {offerBrowserSets && browserSets && (
        <div className="rounded-xl border border-accent/30 bg-accent/5 px-4 py-3 text-sm">
          <p>
            This browser has TLD and platform tag lists saved from Bulk Actions that differ from the ones below:{" "}
            <span className="text-muted-foreground">
              {browserSets.tld.map((t) => t.name).join(", ")} · {browserSets.platform.map((t) => t.name).join(", ")}
            </span>
          </p>
          <button
            type="button"
            className="pv-btn-ghost mt-2 text-xs"
            onClick={() => {
              setField("tags", "tld", clone(browserSets.tld));
              setDraft((d) => (d ? { ...d, tags: { ...d.tags, platform: clone(browserSets.platform) } } : d));
            }}
          >
            Use this browser&apos;s lists
          </button>
        </div>
      )}

      {draft &&
        SECTIONS.map((section) => (
          <SectionCard
            key={section.key}
            section={section}
            values={draft[section.key]}
            savedValues={saved?.[section.key]}
            onChange={(key, value) => setField(section.key, key, value)}
          />
        ))}

      {draft && (
        <p className="text-xs text-muted-foreground">
          {updatedAt > 0 ? `Last saved ${new Date(updatedAt).toLocaleString()}.` : "Never saved — the tools are using the defaults shown."}{" "}
          To add a setting, add it to <span className="font-mono">src/lib/general-settings/settings.ts</span>: it then
          appears on this page, with its own editor and checks.
        </p>
      )}

      {draft && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-background/95 backdrop-blur">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6">
            <span className="text-sm text-muted-foreground">
              {toast ? (
                <span className="inline-flex items-center gap-1.5 text-success">
                  <CheckIcon size={14} /> {toast}
                </span>
              ) : dirty ? (
                <span className="text-warning">Unsaved changes</span>
              ) : (
                "All changes saved"
              )}
            </span>
            <div className="flex gap-2">
              <button type="button" className="pv-btn-ghost" disabled={!dirty || saving} onClick={() => saved && setDraft(clone(saved))}>
                Discard
              </button>
              <button type="button" className="pv-btn-primary" disabled={!dirty || saving} onClick={save}>
                {saving ? <Spinner size={14} /> : null} Save settings
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SectionCard({
  section,
  values,
  savedValues,
  onChange,
}: {
  section: SectionDef;
  values: Record<string, unknown>;
  savedValues?: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}) {
  return (
    <section id={section.key} className="pv-card scroll-mt-20 space-y-4 p-4 sm:p-5">
      <div>
        <h2 className="text-base font-semibold">{section.title}</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">{section.description}</p>
      </div>
      <div className="divide-y divide-border">
        {section.fields.map((f) => {
          const value = values[f.key];
          const def = DEFAULTS[section.key][f.key];
          const changed = savedValues ? !same(value, savedValues[f.key]) : false;
          return (
            <div key={f.key} className="grid gap-2 py-4 first:pt-0 last:pb-0 lg:grid-cols-[260px_1fr] lg:gap-6">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium">
                  {f.label}
                  {changed && <span className="h-1.5 w-1.5 rounded-full bg-warning" title="Changed, not saved" />}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">{f.help}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">Used by: {f.usedBy.join(" · ")}</p>
                {!same(value, def) && (
                  <button type="button" className="mt-1 text-[11px] text-accent underline" onClick={() => onChange(f.key, clone(def))}>
                    Reset to default
                  </button>
                )}
              </div>
              <div className="min-w-0 space-y-1.5">
                <FieldEditor def={f} value={value} onChange={(v) => onChange(f.key, v)} />
                {f.caution && <p className="text-[11px] text-muted-foreground">{f.caution}</p>}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function FieldEditor({ def, value, onChange }: { def: FieldDef; value: unknown; onChange: (v: unknown) => void }) {
  switch (def.kind) {
    case "text":
    case "url":
      return (
        <input
          type="text"
          className="pv-input text-sm"
          value={String(value ?? "")}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          aria-label={def.label}
        />
      );
    case "number":
      return (
        <input
          type="number"
          className="pv-input w-32 text-sm"
          min={def.min}
          max={def.max}
          step={1}
          value={value === "" ? "" : String(value ?? "")}
          onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
          aria-label={def.label}
        />
      );
    case "list":
      return (
        <textarea
          className="pv-input min-h-[88px] text-sm"
          value={((value as string[]) ?? []).join("\n")}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value.split("\n"))}
          aria-label={def.label}
        />
      );
    case "tag":
      return <TagEditor value={value as TagInput} onChange={onChange} label={def.label} />;
    case "tagList":
      return <TagListEditor value={(value as TagInput[]) ?? []} onChange={onChange} label={def.label} />;
    case "spintax":
      return <SpintaxEditor value={String(value ?? "")} onChange={onChange} label={def.label} />;
    case "spintaxList":
      return <SpintaxListEditor value={(value as string[]) ?? []} onChange={onChange} label={def.label} />;
  }
}

function TagEditor({ value, onChange, label, onRemove }: { value: TagInput; onChange: (v: TagInput) => void; label: string; onRemove?: () => void }) {
  const bad = normalizeColor(value.color ?? "") === null;
  return (
    <div className={`grid items-center gap-1.5 ${onRemove ? "grid-cols-[1fr_auto_96px_auto]" : "grid-cols-[1fr_auto_96px]"}`}>
      <input
        type="text"
        className="pv-input text-sm"
        value={value.name}
        spellCheck={false}
        onChange={(e) => onChange({ ...value, name: e.target.value })}
        aria-label={`${label} name`}
      />
      <input
        type="color"
        className="h-9 w-10 cursor-pointer rounded-lg border border-border bg-transparent p-0.5"
        value={normalizeColor(value.color ?? "") ?? "#000000"}
        onChange={(e) => onChange({ ...value, color: e.target.value.toUpperCase() })}
        title="Colour, used when the tag has to be created"
      />
      <input
        type="text"
        className={`pv-input font-mono text-xs ${bad ? "border-danger" : ""}`}
        value={value.color}
        spellCheck={false}
        onChange={(e) => onChange({ ...value, color: e.target.value })}
        aria-label={`${label} colour`}
      />
      {onRemove && (
        <button type="button" className="pv-btn-ghost text-xs" onClick={onRemove} title="Remove">
          <TrashIcon size={14} />
        </button>
      )}
    </div>
  );
}

function TagListEditor({ value, onChange, label }: { value: TagInput[]; onChange: (v: TagInput[]) => void; label: string }) {
  const seen = new Map<string, number>();
  for (const t of value) seen.set(tagKey(t.name), (seen.get(tagKey(t.name)) ?? 0) + 1);
  return (
    <div className="space-y-1.5">
      {value.map((t, i) => (
        <div key={i}>
          <TagEditor
            value={t}
            label={label}
            onChange={(next) => onChange(value.map((x, j) => (j === i ? next : x)))}
            onRemove={() => onChange(value.filter((_, j) => j !== i))}
          />
          {t.name.trim() && (seen.get(tagKey(t.name)) ?? 0) > 1 && <p className="mt-0.5 text-xs text-warning">&quot;{t.name}&quot; is in the list twice.</p>}
        </div>
      ))}
      <button type="button" className="pv-btn-ghost text-xs" onClick={() => onChange([...value, { name: "", color: "#6B7280" }])}>
        + Add tag
      </button>
    </div>
  );
}

function optionCount(block: string): number | null {
  return spintaxOptions(block)?.length ?? null;
}

function SpintaxEditor({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const n = useMemo(() => optionCount(value), [value]);
  return (
    <div className="space-y-1">
      <textarea
        className="pv-input min-h-[160px] font-mono text-xs"
        value={value}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
      />
      <p className={`text-[11px] ${n === null || n < 5 ? "text-warning" : "text-muted-foreground"}`}>
        {n === null ? "Not a single {{Random | … }} block yet." : `${formatNumber(n)} options.`}
      </p>
    </div>
  );
}

function SpintaxListEditor({ value, onChange, label }: { value: string[]; onChange: (v: string[]) => void; label: string }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="space-y-1.5">
      {value.length === 0 && <p className="text-xs text-muted-foreground">None.</p>}
      {value.map((block, i) => {
        const n = optionCount(block);
        return (
          <div key={i} className="rounded-xl border border-border p-2">
            <div className="flex items-center justify-between gap-2">
              <button type="button" className="min-w-0 flex-1 truncate text-left text-xs" onClick={() => setOpen(open === i ? null : i)}>
                <span className="font-medium">Version {i + 1}</span>{" "}
                <span className="text-muted-foreground">
                  · {n === null ? "not a valid block" : `${formatNumber(n)} options`} · {block.slice(0, 90)}…
                </span>
              </button>
              <button type="button" className="pv-btn-ghost text-xs" onClick={() => onChange(value.filter((_, j) => j !== i))} title="Remove">
                <TrashIcon size={14} />
              </button>
            </div>
            {open === i && (
              <textarea
                className="pv-input mt-2 min-h-[140px] font-mono text-xs"
                value={block}
                spellCheck={false}
                onChange={(e) => onChange(value.map((x, j) => (j === i ? e.target.value : x)))}
                aria-label={`${label} ${i + 1}`}
              />
            )}
          </div>
        );
      })}
      <button
        type="button"
        className="pv-btn-ghost text-xs"
        onClick={() => {
          onChange([...value, ""]);
          setOpen(value.length);
        }}
      >
        + Add an older version
      </button>
    </div>
  );
}
