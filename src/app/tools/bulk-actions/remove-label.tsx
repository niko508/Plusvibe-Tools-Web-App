"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Workspace } from "@/lib/plusvibe-types";
import { MAX_REMOVE_LABELS } from "@/lib/lead-labels/custom-label";
import {
  fetchLeadLabels,
  removeLeadLabelsFromWorkspaces,
  ApiClientError,
  type MergedLeadLabel,
  type RemoveLabelsResponse,
} from "@/lib/api-client";
import { formatNumber } from "@/lib/format";
import { Spinner } from "@/components/ui";
import { AlertIcon, RefreshIcon, TrashIcon } from "@/components/icons";

// Deletes custom lead labels from every selected workspace.
//
// The labels to pick are read from the selected workspaces themselves — the
// custom ones only, with how many workspaces have each — and matched by key,
// never by a similar name. Plusvibe detaches a deleted label from every lead,
// webhook and subsequence trigger carrying it, so it previews first and asks
// before deleting.

/** The label list endpoint reads this many workspaces per call. */
const READ_CHUNK = 50;

const errText = (err: unknown) =>
  err instanceof ApiClientError || err instanceof Error ? err.message : "Something went wrong";

export function RemoveLabels({
  workspaces,
  selected,
  loading,
}: {
  workspaces: Workspace[];
  selected: Set<string>;
  loading: boolean;
}) {
  const chosen = useMemo(
    () => workspaces.filter((w) => selected.has(w._id)).map((w) => ({ id: w._id, name: w.name })),
    [workspaces, selected]
  );
  const chosenIds = chosen.map((c) => c.id).join(",");

  const [labels, setLabels] = useState<MergedLeadLabel[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [reading, setReading] = useState(false);
  const [readTick, setReadTick] = useState(0);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [result, setResult] = useState<RemoveLabelsResponse | null>(null);
  const [resultFor, setResultFor] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runLock = useRef(false);

  // The custom labels of the selected workspaces, read again whenever the
  // selection changes, a few dozen workspaces per call.
  useEffect(() => {
    if (chosen.length === 0) {
      setLabels(null);
      return;
    }
    const ctrl = new AbortController();
    setReading(true);
    setError(null);
    (async () => {
      const byKey = new Map<string, MergedLeadLabel>();
      let failed = 0;
      for (let i = 0; i < chosen.length; i += READ_CHUNK) {
        const part = chosen.slice(i, i + READ_CHUNK).map((c) => c.id);
        const r = await fetchLeadLabels(part, ctrl.signal);
        failed += r.failed.length;
        for (const l of r.labels) {
          if (l.isSystem) continue;
          const had = byKey.get(l.key);
          if (had) had.presentIn += l.presentIn;
          else byKey.set(l.key, { ...l });
        }
      }
      if (ctrl.signal.aborted) return;
      setLabels([...byKey.values()].sort((a, b) => b.presentIn - a.presentIn || a.name.localeCompare(b.name)));
      setUnread(failed);
      // Keep only picks that still exist.
      setPicked((prev) => new Set([...prev].filter((k) => byKey.has(k))));
    })()
      .catch((err) => {
        if (!ctrl.signal.aborted) setError(errText(err));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setReading(false);
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosenIds, readTick]);

  const keys = [...picked];
  const pickedKey = `${keys.sort().join("|")} ${chosenIds}`;
  const stale = result !== null && resultFor !== pickedKey;
  const canRun = chosen.length > 0 && keys.length > 0 && keys.length <= MAX_REMOVE_LABELS && !busy;
  const shown = (labels ?? []).filter((l) => !filter.trim() || l.name.toLowerCase().includes(filter.trim().toLowerCase()));

  function toggle(key: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function run(dryRun: boolean) {
    if (!canRun || runLock.current) return;
    if (!dryRun) {
      const names = (labels ?? []).filter((l) => picked.has(l.key)).map((l) => l.name);
      const ok = window.confirm(
        `Delete ${names.length === 1 ? `"${names[0]}"` : `${names.length} labels`} from ${chosen.length} workspace${chosen.length === 1 ? "" : "s"}? ` +
          "Plusvibe also takes the label off every lead that has it, and out of any webhook or subsequence trigger using it. This can't be undone."
      );
      if (!ok) return;
    }
    runLock.current = true;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await removeLeadLabelsFromWorkspaces({ workspaces: chosen, keys, dryRun }));
      setResultFor(pickedKey);
      if (!dryRun) setReadTick((n) => n + 1);
    } catch (err) {
      setError(errText(err));
    } finally {
      runLock.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="pv-card space-y-4 p-4 sm:p-5">
        <div>
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">Custom labels in the selected workspaces</span>
            {labels && labels.length > 8 && (
              <input
                type="text"
                className="pv-input w-48 py-1 text-xs"
                placeholder="Filter labels…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                aria-label="Filter labels"
              />
            )}
          </div>
          {chosen.length === 0 ? (
            <p className="text-xs text-muted-foreground">{loading ? "Loading workspaces…" : "Pick some workspaces above first."}</p>
          ) : reading && !labels ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner size={12} /> Reading the labels…
            </p>
          ) : labels && labels.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-no-labels>
              None of the selected workspaces has a custom label. Built-in labels can&apos;t be deleted.
            </p>
          ) : (
            <div className="pv-scroll max-h-72 space-y-1 overflow-y-auto rounded-xl border border-border p-1.5" data-label-list>
              {shown.map((l) => (
                <label key={l.key} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-muted/40" data-label-option={l.key}>
                  <input type="checkbox" checked={picked.has(l.key)} onChange={() => toggle(l.key)} aria-label={`Remove ${l.name}`} />
                  <span className="min-w-0 flex-1 truncate text-sm">{l.name}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                    in {formatNumber(l.presentIn)} of {formatNumber(chosen.length)}
                  </span>
                </label>
              ))}
              {shown.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">No label matches.</p>}
            </div>
          )}
          {unread > 0 && (
            <p className="mt-1.5 text-[11px] text-warning">
              {formatNumber(unread)} workspace{unread === 1 ? "" : "s"} couldn&apos;t be read, so their labels aren&apos;t listed.
            </p>
          )}
          {keys.length > MAX_REMOVE_LABELS && (
            <p className="mt-1.5 text-[11px] text-warning">At most {MAX_REMOVE_LABELS} labels at a time.</p>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          A label is matched by its exact key in each workspace, never by a similar name, and built-in labels are never
          touched. Deleting a label also takes it off every lead that has it and out of any webhook or subsequence trigger
          using it — preview first.
        </p>

        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger">
            <AlertIcon size={16} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="pv-btn-ghost disabled:opacity-50" disabled={!canRun} onClick={() => run(true)} data-remove-preview>
            {busy ? <Spinner /> : <RefreshIcon size={16} />}
            Preview
          </button>
          <button type="button" className="pv-btn-ghost text-danger disabled:opacity-50" disabled={!canRun} onClick={() => run(false)} data-remove-run>
            {busy ? <Spinner /> : <TrashIcon size={16} />}
            Delete {keys.length > 1 ? `${formatNumber(keys.length)} labels ` : ""}from {formatNumber(chosen.length)} workspace{chosen.length === 1 ? "" : "s"}
          </button>
        </div>
      </div>

      {result && <RemoveResultCard result={result} stale={stale} />}
    </div>
  );
}

function RemoveResultCard({ result, stale }: { result: RemoveLabelsResponse; stale: boolean }) {
  const [open, setOpen] = useState(false);
  const shown = open ? result.results : result.results.slice(0, 8);
  return (
    <div className="pv-card p-4 sm:p-5" data-remove-result>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{result.dryRun ? "Preview" : "Done"}</h2>
        {result.dryRun && <span className="text-xs text-muted-foreground">Nothing has been deleted yet.</span>}
      </div>
      {stale && (
        <p className="mt-2 flex gap-1.5 text-xs text-warning">
          <AlertIcon size={13} className="mt-0.5 shrink-0" />
          <span>The labels or the workspace selection changed since this ran, so it no longer describes what would happen.</span>
        </p>
      )}
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={result.dryRun ? "Workspaces to change" : "Workspaces changed"} value={result.totals.removed} tone="success" />
        <Stat label={result.dryRun ? "Labels to delete" : "Labels deleted"} value={result.totals.labels} />
        <Stat label="Didn't have them" value={result.totals.absent} />
        <Stat label="Errors" value={result.totals.errors} tone={result.totals.errors > 0 ? "danger" : undefined} />
      </div>
      <div className="pv-scroll mt-4 max-h-80 overflow-y-auto rounded-xl border border-border">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="px-3 py-2 font-medium">Workspace</th>
              <th className="px-3 py-2 font-medium">Result</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.workspaceId} className="border-b border-border/70 last:border-0" data-remove-row={r.workspaceId}>
                <td className="px-3 py-2">{r.workspaceName || r.workspaceId}</td>
                <td className="px-3 py-2">
                  {r.outcome === "removed" && (
                    <span className="text-success">
                      {result.dryRun ? "will delete" : "deleted"} {r.labels.join(", ")}
                    </span>
                  )}
                  {r.outcome === "absent" && <span className="text-muted-foreground">doesn&apos;t have them</span>}
                  {r.outcome === "error" && <span className="text-danger">{r.reason || "failed"}</span>}
                  {r.outcome === "removed" && r.reason && <span className="text-warning"> · {r.reason}</span>}
                  {r.builtIn && r.builtIn.length > 0 && <span className="text-muted-foreground"> · built-in here, left alone: {r.builtIn.join(", ")}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {result.results.length > shown.length && (
        <button type="button" className="pv-btn-ghost mt-2 text-xs" onClick={() => setOpen(true)}>
          Show all {result.results.length}
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
