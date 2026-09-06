"use client";

import { useMemo, useRef, useState } from "react";
import type { Workspace } from "@/lib/plusvibe-types";
import {
  MAX_TAG_NAME_LENGTH,
  normalizeColor,
  prepareBatch,
  type TagInput,
} from "@/lib/tags/bulk-tags";
import { addTagsToWorkspaces, ApiClientError, type BulkTagsResponse } from "@/lib/api-client";
import { formatNumber } from "@/lib/format";
import { Spinner } from "@/components/ui";
import { AlertIcon, RefreshIcon, TagIcon, TrashIcon } from "@/components/icons";

// Creates one or more tags in every selected workspace. A workspace that
// already has a tag of that name (case-insensitively, like Plusvibe) is
// skipped for that tag rather than failed.

/** A few sensible defaults so a colour never has to be typed. */
const PALETTE = ["#FF5733", "#3B82F6", "#10B981", "#F59E0B", "#8B5CF6", "#EC4899", "#14B8A6", "#6B7280"];

interface Row extends TagInput {
  key: number;
}

let nextKey = 1;
const blankRow = (i: number): Row => ({ key: nextKey++, name: "", color: PALETTE[i % PALETTE.length], description: "" });

export function AddTags({
  workspaces,
  selected,
  loading,
}: {
  workspaces: Workspace[];
  selected: Set<string>;
  loading: boolean;
}) {
  const [rows, setRows] = useState<Row[]>([blankRow(0)]);
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
  const filled = rows.filter((r) => r.name.trim() !== "" || (r.description ?? "").trim() !== "");
  const batch = prepareBatch(filled);
  const canRun = chosen.length > 0 && batch.specs.length > 0 && batch.problems.size === 0 && !busy;

  const fingerprint = JSON.stringify([chosenIds, filled.map((r) => [r.name, r.color, r.description])]);
  const [resultFor, setResultFor] = useState("");
  const stale = result !== null && resultFor !== fingerprint;

  function update(key: number, patch: Partial<TagInput>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  async function run(dryRun: boolean) {
    if (!canRun || runLock.current) return;
    runLock.current = true;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await addTagsToWorkspaces({ workspaces: chosen, tags: filled, dryRun }));
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
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              Tags to create{" "}
              <span className="font-normal">
                · {formatNumber(batch.specs.length)} ready
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
              return (
                <div key={r.key} className="rounded-xl border border-border p-2.5">
                  <div className="grid gap-2 sm:grid-cols-[1fr_150px_1.4fr_auto]">
                    <input
                      type="text"
                      className="pv-input text-sm"
                      placeholder={i === 0 ? "VIP Clients" : "Tag name"}
                      value={r.name}
                      maxLength={MAX_TAG_NAME_LENGTH * 2}
                      onChange={(e) => update(r.key, { name: e.target.value })}
                    />
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
                    <input
                      type="text"
                      className="pv-input text-sm"
                      placeholder="Description (optional)"
                      value={r.description ?? ""}
                      onChange={(e) => update(r.key, { description: e.target.value })}
                    />
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
                  {problems.length > 0 && (
                    <p className="mt-1.5 flex gap-1.5 text-xs text-warning">
                      <AlertIcon size={13} className="mt-0.5 shrink-0" />
                      <span>{problems.join(" ")}</span>
                    </p>
                  )}
                  {dup && (
                    <p className="mt-1.5 text-xs text-muted-foreground">Same name as an earlier row — only the first is created.</p>
                  )}
                </div>
              );
            })}
          </div>
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
        </div>

        <p className="text-xs text-muted-foreground">
          Tag names are case-insensitive and unique per workspace, so a workspace that already has one of these
          names is skipped for that tag rather than failed. Preview first to see exactly what would be created.
        </p>

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
          <button type="button" className="pv-btn-primary disabled:opacity-50" disabled={!canRun} onClick={() => run(false)}>
            {busy ? <Spinner /> : <TagIcon size={16} />}
            Add {formatNumber(batch.specs.length)} tag{batch.specs.length === 1 ? "" : "s"} to {formatNumber(chosen.length)} workspace
            {chosen.length === 1 ? "" : "s"}
          </button>
          {chosen.length === 0 && !loading && <span className="text-xs text-muted-foreground">Pick some workspaces above first.</span>}
        </div>
      </div>

      {result && <ResultCard result={result} stale={stale} />}
    </div>
  );
}

function ResultCard({ result, stale }: { result: BulkTagsResponse; stale: boolean }) {
  const [open, setOpen] = useState(false);
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
        {result.dryRun && <span className="text-xs text-muted-foreground">Nothing has been created yet.</span>}
      </div>
      {stale && (
        <p className="mt-2 flex gap-1.5 text-xs text-warning">
          <AlertIcon size={13} className="mt-0.5 shrink-0" />
          <span>The tags or the workspace selection changed since this ran, so it no longer describes what would happen.</span>
        </p>
      )}
      <div className="mt-3 grid grid-cols-3 gap-3">
        <Stat label={result.dryRun ? "Would be created" : "Created"} value={result.totals.created} tone="success" />
        <Stat label="Already there" value={result.totals.already} />
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
                            : r.outcome === "already"
                              ? "bg-muted text-muted-foreground"
                              : "bg-danger/10 text-danger"
                        }`}
                        title={r.reason ?? (r.outcome === "already" ? `already has "${r.existingName}"` : "")}
                      >
                        {r.tag} · {r.outcome === "created" ? (result.dryRun ? "will create" : "created") : r.outcome === "already" ? "already there" : r.reason || "failed"}
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
