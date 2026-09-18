"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Workspace } from "@/lib/plusvibe-types";
import {
  MAX_TAG_NAME_LENGTH,
  normalizeColor,
  prepareBatch,
  prepareRemoveBatch,
  type TagInput,
} from "@/lib/tags/bulk-tags";
import { addTagsToWorkspaces, fetchTagCatalog, ApiClientError, type BulkTagsResponse } from "@/lib/api-client";
import type { CatalogTag } from "@/lib/inbox-tags/plan";
import { formatNumber } from "@/lib/format";
import { Spinner } from "@/components/ui";
import { AlertIcon, RefreshIcon, TagIcon, TrashIcon } from "@/components/icons";
import { AutoDomainTags } from "./auto-domain-tags";

// Creates or deletes one or more tags across the selected workspaces.
//
// Adding is forgiving: a workspace that already has a tag of that name
// (case-insensitively, like Plusvibe) is skipped rather than failed.
//
// Removing is not. Deleting a tag in Plusvibe also strips it from every inbox
// and campaign that carried it, and nothing brings that back — so removal
// insists on a preview of exactly what would go first, and only then offers
// the button that does it.

/** A few sensible defaults so a colour never has to be typed. */
const PALETTE = ["#FF5733", "#3B82F6", "#10B981", "#F59E0B", "#8B5CF6", "#EC4899", "#14B8A6", "#6B7280"];

interface Row extends TagInput {
  key: number;
  /**
   * Removal picks from the tags the selected workspaces actually have. A row
   * set to `custom` types a name instead — for a tag the list doesn't show,
   * or one only some workspaces have under a slightly different spelling.
   */
  custom?: boolean;
}

/** The option value for "not in the list — let me type it". */
const TYPE_IT = "__type__";

let nextKey = 1;
const blankRow = (i: number): Row => ({ key: nextKey++, name: "", color: PALETTE[i % PALETTE.length], description: "" });

type Mode = "add" | "remove";

/**
 * The option to show as selected for a row's name.
 *
 * Names are matched case-insensitively, like everything else about tags, so a
 * row carrying "vip clients" still shows the catalogue's "VIP Clients".
 */
function pickValue(name: string, catalog: CatalogTag[] | null): string {
  const key = name.trim().toLowerCase();
  if (!key) return "";
  return catalog?.find((t) => t.name.trim().toLowerCase() === key)?.name ?? "";
}

export function AddTags({
  workspaces,
  selected,
  loading,
}: {
  workspaces: Workspace[];
  selected: Set<string>;
  loading: boolean;
}) {
  const [mode, setMode] = useState<Mode>("add");
  const [rows, setRows] = useState<Row[]>([blankRow(0)]);
  const [catalog, setCatalog] = useState<CatalogTag[] | null>(null);
  const [catalogFor, setCatalogFor] = useState("");
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogNote, setCatalogNote] = useState<string | null>(null);
  const [result, setResult] = useState<BulkTagsResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runLock = useRef(false);

  const chosen = useMemo(
    () => workspaces.filter((w) => selected.has(w._id)).map((w) => ({ id: w._id, name: w.name })),
    [workspaces, selected]
  );
  const chosenIds = chosen.map((c) => c.id).join(",");

  // Rows left entirely blank are ignored, so an extra empty row never blocks.
  const removing = mode === "remove";
  // When removing, only the name matters, so a row with just a description is
  // not a row at all.
  const filled = rows.filter((r) =>
    removing ? r.name.trim() !== "" : r.name.trim() !== "" || (r.description ?? "").trim() !== ""
  );
  const addBatch = prepareBatch(filled);
  const removeBatch = prepareRemoveBatch(filled);
  const batch = removing
    ? { count: removeBatch.names.length, problems: removeBatch.problems, duplicates: removeBatch.duplicates }
    : { count: addBatch.specs.length, problems: addBatch.problems, duplicates: addBatch.duplicates };
  const canRun = chosen.length > 0 && batch.count > 0 && batch.problems.size === 0 && !busy;

  const fingerprint = JSON.stringify([mode, chosenIds, filled.map((r) => [r.name, r.color, r.description])]);
  const [resultFor, setResultFor] = useState("");
  const stale = result !== null && resultFor !== fingerprint;
  // Removal is irreversible, so the button that does it only unlocks once a
  // preview of this exact selection has been seen.
  const previewed = result !== null && result.dryRun && !stale && result.mode === "remove";

  function update(key: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  // --- What the selected workspaces actually have --------------------------
  // Only read while removing: adding names tags that don't exist yet, so a
  // list of existing ones would be noise there.
  const loadCatalog = useCallback(async (targets: { id: string; name: string }[], ids: string) => {
    if (targets.length === 0) {
      setCatalog(null);
      setCatalogFor("");
      return;
    }
    setCatalogBusy(true);
    setCatalogNote(null);
    try {
      const res = await fetchTagCatalog(targets);
      setCatalog(res.tags);
      setCatalogFor(ids);
      if (res.failed.length > 0) {
        setCatalogNote(
          `Could not read the tags of ${res.failed.length} workspace${res.failed.length === 1 ? "" : "s"} (${res.failed
            .slice(0, 3)
            .map((f) => f.workspaceName || f.workspaceId)
            .join(", ")}${res.failed.length > 3 ? ", …" : ""}), so their tags aren't in this list.`
        );
      }
    } catch (err) {
      setCatalogNote(
        `Could not read the tags in use: ${err instanceof Error ? err.message : "failed"}. Type the names instead.`
      );
    } finally {
      setCatalogBusy(false);
    }
  }, []);
  useEffect(() => {
    if (!removing || chosenIds === catalogFor) return;
    // A short pause so ticking several workspaces makes one read, not many.
    const t = setTimeout(() => void loadCatalog(chosen, chosenIds), 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [removing, chosenIds]);

  async function run(dryRun: boolean) {
    if (!canRun || runLock.current) return;
    runLock.current = true;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await addTagsToWorkspaces({ workspaces: chosen, tags: filled, mode, dryRun }));
      setResultFor(fingerprint);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : err instanceof Error ? err.message : "Something went wrong");
    } finally {
      runLock.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="pv-card space-y-4 p-4 sm:p-5">
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs" role="radiogroup" aria-label="Add or remove">
            {(["add", "remove"] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                onClick={() => setMode(m)}
                className={`pv-chip ${mode === m ? "pv-chip-active" : "hover:text-foreground"}`}
              >
                {m === "add" ? "Add tags" : "Remove tags"}
              </button>
            ))}
          </div>
          {removing && (
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                {catalogBusy
                  ? `Reading the tags in ${formatNumber(chosen.length)} workspace${chosen.length === 1 ? "" : "s"}…`
                  : catalog
                    ? `${formatNumber(catalog.length)} tag${catalog.length === 1 ? "" : "s"} in use across ${formatNumber(chosen.length)} workspace${chosen.length === 1 ? "" : "s"}`
                    : "Pick some workspaces to see their tags."}
              </span>
              <button
                type="button"
                className="pv-btn-ghost text-xs"
                disabled={catalogBusy || chosen.length === 0}
                onClick={() => void loadCatalog(chosen, chosenIds)}
              >
                {catalogBusy ? <Spinner size={12} /> : <RefreshIcon size={12} />}
                Reload tags
              </button>
            </div>
          )}
          {catalogNote && removing && (
            <p className="mb-1.5 flex gap-1.5 text-xs text-warning">
              <AlertIcon size={13} className="mt-0.5 shrink-0" />
              <span>{catalogNote}</span>
            </p>
          )}
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              {removing ? "Tags to remove" : "Tags to create"}{" "}
              <span className="font-normal">
                · {formatNumber(batch.count)} ready
                {batch.duplicates.length > 0 && ` · ${batch.duplicates.length} repeated name${batch.duplicates.length === 1 ? "" : "s"} ignored`}
              </span>
            </span>
            <button type="button" className="pv-btn-ghost text-xs" onClick={() => setRows((prev) => [...prev, blankRow(prev.length)])}>
              + Add another tag
            </button>
          </div>
          <div className="space-y-2">
            {rows.map((r, i) => {
              const idx = filled.findIndex((f) => f.key === r.key);
              const problems = idx >= 0 ? batch.problems.get(idx) ?? [] : [];
              const dup = idx >= 0 && batch.duplicates.includes(idx);
              const swatch = normalizeColor(r.color);
              // The dropdown can only show a name it has an option for. A row
              // naming a tag the list doesn't carry — typed, or picked before
              // the list changed — shows the name in a field instead, so it is
              // never armed for removal while appearing blank.
              const showList =
                removing &&
                !r.custom &&
                (r.name.trim() === "" || catalog === null || pickValue(r.name, catalog) !== "");
              return (
                <div key={r.key} className="rounded-xl border border-border p-2.5">
                  <div className={`grid gap-2 ${removing ? "sm:grid-cols-[1fr_auto]" : "sm:grid-cols-[1fr_150px_1.4fr_auto]"}`}>
                    {showList ? (
                      <select
                        className="pv-input text-sm"
                        value={pickValue(r.name, catalog)}
                        onChange={(e) => {
                          if (e.target.value === TYPE_IT) update(r.key, { custom: true, name: "" });
                          else update(r.key, { name: e.target.value });
                        }}
                        aria-label="Tag to remove"
                      >
                        <option value="">
                          {catalogBusy
                            ? "Reading the tags in use…"
                            : catalog === null
                              ? "Pick some workspaces first…"
                              : catalog.length === 0
                                ? "No tags in these workspaces"
                                : "Pick a tag…"}
                        </option>
                        {(catalog ?? []).map((t) => (
                          <option key={t.name} value={t.name}>
                            {t.name}
                            {chosen.length > 1 ? ` — in ${t.count} of ${chosen.length}` : ""}
                          </option>
                        ))}
                        <option value={TYPE_IT}>Type a name instead…</option>
                      </select>
                    ) : (
                      <input
                        type="text"
                        className="pv-input text-sm"
                        placeholder={i === 0 ? "VIP Clients" : "Tag name"}
                        value={r.name}
                        maxLength={MAX_TAG_NAME_LENGTH * 2}
                        onChange={(e) => update(r.key, { name: e.target.value })}
                        aria-label={removing ? "Tag name to remove" : "Tag name"}
                      />
                    )}
                    {!removing && (
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        className="h-9 w-10 cursor-pointer rounded-lg border border-border bg-transparent p-0.5"
                        value={swatch ?? "#000000"}
                        onChange={(e) => update(r.key, { color: e.target.value })}
                        title="Pick a colour"
                      />
                      <input
                        type="text"
                        className="pv-input font-mono text-xs"
                        placeholder="#FF5733"
                        value={r.color}
                        onChange={(e) => update(r.key, { color: e.target.value })}
                        spellCheck={false}
                      />
                    </div>
                    )}
                    {!removing && (
                    <input
                      type="text"
                      className="pv-input text-sm"
                      placeholder="Description (optional)"
                      value={r.description ?? ""}
                      onChange={(e) => update(r.key, { description: e.target.value })}
                    />
                    )}
                    <div className="flex items-center gap-1">
                      {removing && !showList && (
                        <button
                          type="button"
                          className="pv-btn-ghost text-xs"
                          onClick={() => update(r.key, { custom: false, name: "" })}
                          title="Pick from the tags in use instead"
                        >
                          List
                        </button>
                      )}
                      <button
                        type="button"
                        className="pv-btn-ghost text-xs"
                        disabled={rows.length === 1}
                        onClick={() => setRows((prev) => prev.filter((x) => x.key !== r.key))}
                        title="Remove this row"
                      >
                        <TrashIcon size={14} />
                      </button>
                    </div>
                  </div>
                  {problems.length > 0 && (
                    <p className="mt-1.5 flex gap-1.5 text-xs text-warning">
                      <AlertIcon size={13} className="mt-0.5 shrink-0" />
                      <span>{problems.join(" ")}</span>
                    </p>
                  )}
                  {dup && (
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      Same name as an earlier row — only the first {removing ? "is removed" : "is created"}.
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          {!removing && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">Quick colours</span>
            {PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                className="h-5 w-5 rounded-full border border-border"
                style={{ background: c }}
                title={`${c} — sets the last row`}
                onClick={() => setRows((prev) => prev.map((r, i) => (i === prev.length - 1 ? { ...r, color: c } : r)))}
              />
            ))}
          </div>
          )}
        </div>

        {removing ? (
          <p className="text-xs text-muted-foreground">
            Matched by name, case-insensitively. A workspace that doesn&apos;t have the tag is simply left alone.
            Removing a tag in Plusvibe also takes it off every inbox and campaign that carried it, and that
            can&apos;t be undone — so preview first, and the remove button unlocks once you have.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Tag names are case-insensitive and unique per workspace, so a workspace that already has one of these
            names is skipped for that tag rather than failed. Preview first to see exactly what would be created.
          </p>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger">
            <AlertIcon size={16} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="pv-btn-ghost disabled:opacity-50" disabled={!canRun} onClick={() => run(true)}>
            {busy ? <Spinner /> : <RefreshIcon size={16} />}
            Preview
          </button>
          {removing ? (
            <button
              type="button"
              className="pv-btn-primary bg-danger hover:bg-danger/90 disabled:opacity-50"
              disabled={!canRun || !previewed}
              onClick={() => run(false)}
              title={previewed ? undefined : "Preview first — removing a tag can't be undone"}
            >
              {busy ? <Spinner /> : <TrashIcon size={16} />}
              Remove {formatNumber(batch.count)} tag{batch.count === 1 ? "" : "s"} from {formatNumber(chosen.length)} workspace
              {chosen.length === 1 ? "" : "s"}
            </button>
          ) : (
            <button type="button" className="pv-btn-primary disabled:opacity-50" disabled={!canRun} onClick={() => run(false)}>
              {busy ? <Spinner /> : <TagIcon size={16} />}
              Add {formatNumber(batch.count)} tag{batch.count === 1 ? "" : "s"} to {formatNumber(chosen.length)} workspace
              {chosen.length === 1 ? "" : "s"}
            </button>
          )}
          {chosen.length === 0 && !loading && <span className="text-xs text-muted-foreground">Pick some workspaces above first.</span>}
          {removing && canRun && !previewed && chosen.length > 0 && (
            <span className="text-xs text-muted-foreground">Preview to see what would be removed.</span>
          )}
        </div>
      </div>

      {result && <ResultCard result={result} stale={stale} />}

      <AutoDomainTags workspaces={workspaces} selected={selected} loading={loading} />
    </div>
  );
}

function ResultCard({ result, stale }: { result: BulkTagsResponse; stale: boolean }) {
  const [open, setOpen] = useState(false);
  const removed = result.mode === "remove";
  // One row per workspace, one chip per tag — easier to scan than a long
  // (workspace × tag) list.
  const byWorkspace = new Map<string, { name: string; results: BulkTagsResponse["results"] }>();
  for (const r of result.results) {
    const g = byWorkspace.get(r.workspaceId) ?? { name: r.workspaceName, results: [] };
    g.results.push(r);
    byWorkspace.set(r.workspaceId, g);
  }
  const groups = [...byWorkspace.entries()];
  const shown = open ? groups : groups.slice(0, 8);

  return (
    <div className="pv-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">
          {result.dryRun ? "Preview" : "Done"}
          <span className="ml-1.5 font-normal text-muted-foreground">
            · {result.tags.map((t) => t.name).join(", ")}
          </span>
        </h2>
        {result.dryRun && (
          <span className="text-xs text-muted-foreground">
            Nothing has been {removed ? "removed" : "created"} yet.
          </span>
        )}
      </div>
      {stale && (
        <p className="mt-2 flex gap-1.5 text-xs text-warning">
          <AlertIcon size={13} className="mt-0.5 shrink-0" />
          <span>The tags or the workspace selection changed since this ran, so it no longer describes what would happen.</span>
        </p>
      )}
      <div className="mt-3 grid grid-cols-3 gap-3">
        {removed ? (
          <>
            <Stat
              label={result.dryRun ? "Would be removed" : "Removed"}
              value={result.totals.removed ?? 0}
              tone={(result.totals.removed ?? 0) > 0 ? "danger" : undefined}
            />
            <Stat label="Not there" value={result.totals.missing ?? 0} />
          </>
        ) : (
          <>
            <Stat label={result.dryRun ? "Would be created" : "Created"} value={result.totals.created} tone="success" />
            <Stat label="Already there" value={result.totals.already} />
          </>
        )}
        <Stat label="Errors" value={result.totals.errors} tone={result.totals.errors > 0 ? "danger" : undefined} />
      </div>
      <div className="pv-scroll mt-4 max-h-96 overflow-y-auto rounded-xl border border-border">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="px-3 py-2 font-medium">Workspace</th>
              <th className="px-3 py-2 font-medium">Tags</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(([id, g]) => (
              <tr key={id} className="border-b border-border/70 align-top last:border-0">
                <td className="px-3 py-2">{g.name || id}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1.5">
                    {g.results.map((r) => (
                      <span
                        key={r.tag}
                        className={`rounded-full px-2 py-0.5 ${
                          r.outcome === "created"
                            ? "bg-success/10 text-success"
                            : r.outcome === "removed"
                              ? "bg-danger/10 text-danger"
                              : r.outcome === "already" || r.outcome === "missing"
                                ? "bg-muted text-muted-foreground"
                                : "bg-danger/10 text-danger"
                        }`}
                        title={
                          r.reason ??
                          (r.outcome === "already" || r.outcome === "removed"
                            ? `matched "${r.existingName}"`
                            : "")
                        }
                      >
                        {r.tag} ·{" "}
                        {r.outcome === "created"
                          ? result.dryRun
                            ? "will create"
                            : "created"
                          : r.outcome === "removed"
                            ? result.dryRun
                              ? "will remove"
                              : "removed"
                            : r.outcome === "already"
                              ? "already there"
                              : r.outcome === "missing"
                                ? "not there"
                                : r.reason || "failed"}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {groups.length > shown.length && (
        <button type="button" className="pv-btn-ghost mt-2 text-xs" onClick={() => setOpen(true)}>
          Show all {groups.length}
        </button>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "success" | "danger" }) {
  return (
    <div className="rounded-xl border border-border p-2.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold tabular-nums ${tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : ""}`}>
        {formatNumber(value)}
      </div>
    </div>
  );
}
