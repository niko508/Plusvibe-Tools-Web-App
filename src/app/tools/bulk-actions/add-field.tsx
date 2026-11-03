"use client";

import { useMemo, useRef, useState } from "react";
import type { Workspace } from "@/lib/plusvibe-types";
import {
  normalizeFieldName,
  validateFieldName,
} from "@/lib/additional-fields/field";
import {
  addFieldToWorkspaces,
  ApiClientError,
  type BulkFieldResponse,
} from "@/lib/api-client";
import { formatNumber } from "@/lib/format";
import { Spinner } from "@/components/ui";
import { AlertIcon, LayersIcon, RefreshIcon } from "@/components/icons";

// Creates the same additional field in every selected workspace.
//
// A field's name can't be edited once it exists — only its default value can —
// so a typo pushed to fifty workspaces has to be deleted from fifty workspaces
// by hand. Hence the preview, which reads each workspace's fields and reports
// exactly what would happen without writing anything.

export function AddField({
  workspaces,
  selected,
  loading,
}: {
  workspaces: Workspace[];
  selected: Set<string>;
  loading: boolean;
}) {
  const [name, setName] = useState("");
  const [defaultValue, setDefaultValue] = useState("");
  const [result, setResult] = useState<BulkFieldResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runLock = useRef(false);

  const chosen = useMemo(
    () =>
      workspaces
        .filter((w) => selected.has(w._id))
        .map((w) => ({ id: w._id, name: w.name })),
    [workspaces, selected]
  );

  const problems = validateFieldName(name);
  const normalized = normalizeFieldName(name);
  const canRun = chosen.length > 0 && problems.length === 0 && !busy;

  // A preview stops describing reality the moment the inputs or the selection
  // change, so it's flagged rather than left to be misread.
  const chosenIds = chosen.map((c) => c.id).join(",");
  const [resultFor, setResultFor] = useState("");
  const fingerprint = `${name}|${defaultValue}|${chosenIds}`;
  const stale = result !== null && resultFor !== fingerprint;

  async function run(dryRun: boolean) {
    if (!canRun || runLock.current) return;
    runLock.current = true;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await addFieldToWorkspaces({
          workspaces: chosen,
          name: name.trim(),
          defaultValue: defaultValue.trim() || undefined,
          dryRun,
        })
      );
      setResultFor(fingerprint);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Something went wrong"
      );
    } finally {
      runLock.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="pv-card space-y-4 p-4 sm:p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Field name
            </label>
            <input
              type="text"
              className="pv-input text-sm"
              placeholder="Industry"
              value={name}
              onChange={(e) => setName(e.target.value)}
              spellCheck={false}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Default value <span className="font-normal">(optional)</span>
            </label>
            <input
              type="text"
              className="pv-input text-sm"
              placeholder="Used when a lead has no value of its own"
              value={defaultValue}
              onChange={(e) => setDefaultValue(e.target.value)}
            />
          </div>
        </div>

        {name.trim() !== "" && normalized !== "" && (
          <div className="rounded-xl border border-border p-3">
            <span className="block text-[11px] text-muted-foreground">
              Stored by Plusvibe as · use it in copy as
            </span>
            <span className="mt-0.5 block font-mono text-sm">
              {normalized}
              <span className="ml-3 text-muted-foreground">
                {"{{"}
                {normalized}
                {"}}"}
              </span>
            </span>
            {normalized !== name.trim() && (
              <span className="mt-1 block text-[11px] text-muted-foreground">
                Plusvibe lowercases the name and turns spaces and punctuation
                into underscores. That is the form leads and copy will use.
              </span>
            )}
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          A field&apos;s name can&apos;t be changed once it exists — only its
          default value can — so a name pushed to every workspace can only be
          undone by deleting it in each one. Preview first. Workspaces that
          already have the field are skipped rather than failed.
        </p>

        {problems.length > 0 && name.trim() !== "" && (
          <div className="space-y-1">
            {problems.map((p, i) => (
              <p key={i} className="flex gap-1.5 text-xs text-warning">
                <AlertIcon size={13} className="mt-0.5 shrink-0" />
                <span>{p}</span>
              </p>
            ))}
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger">
            <AlertIcon size={16} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="pv-btn-ghost disabled:opacity-50"
            disabled={!canRun}
            onClick={() => run(true)}
          >
            {busy ? <Spinner /> : <RefreshIcon size={16} />}
            Preview
          </button>
          <button
            type="button"
            className="pv-btn-primary disabled:opacity-50"
            disabled={!canRun}
            onClick={() => run(false)}
          >
            {busy ? <Spinner /> : <LayersIcon size={16} />}
            Add to {formatNumber(chosen.length)} workspace
            {chosen.length === 1 ? "" : "s"}
          </button>
          {chosen.length === 0 && !loading && (
            <span className="text-xs text-muted-foreground">
              Pick some workspaces above first.
            </span>
          )}
        </div>
      </div>

      {result && <ResultCard result={result} stale={stale} />}
    </div>
  );
}

function ResultCard({
  result,
  stale,
}: {
  result: BulkFieldResponse;
  stale: boolean;
}) {
  const [open, setOpen] = useState(false);
  const shown = open ? result.results : result.results.slice(0, 8);

  return (
    <div className="pv-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">
          {result.dryRun ? "Preview" : "Done"}
          <span className="ml-1.5 font-mono font-normal text-muted-foreground">
            · {result.normalizedName}
            {result.defaultValue ? ` = "${result.defaultValue}"` : ""}
          </span>
        </h2>
        {result.dryRun && (
          <span className="text-xs text-muted-foreground">
            Nothing has been created yet.
          </span>
        )}
      </div>

      {stale && (
        <p className="mt-2 flex gap-1.5 text-xs text-warning">
          <AlertIcon size={13} className="mt-0.5 shrink-0" />
          <span>
            The field or the workspace selection changed since this ran, so it
            no longer describes what would happen.
          </span>
        </p>
      )}

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label={result.dryRun ? "Would be created" : "Created"}
          value={result.totals.created}
          tone="success"
        />
        <Stat label="Already had it" value={result.totals.already} />
        <Stat
          label="Name taken"
          value={result.totals.conflict}
          tone={result.totals.conflict > 0 ? "warning" : undefined}
        />
        <Stat
          label="Errors"
          value={result.totals.errors}
          tone={result.totals.errors > 0 ? "danger" : undefined}
        />
      </div>

      {result.totals.conflict > 0 && (
        <p className="mt-3 text-xs text-warning">
          Plusvibe refused this name outright — it clashes with a standard lead
          field or a campaign variable. That is the same in every workspace, so
          the fix is a different name rather than a retry.
        </p>
      )}

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
              <tr
                key={r.workspaceId}
                className="border-b border-border/70 last:border-0"
              >
                <td className="px-3 py-2">{r.workspaceName || r.workspaceId}</td>
                <td className="px-3 py-2">
                  {r.outcome === "created" && (
                    <span className="text-success">
                      {result.dryRun ? "will be created" : "created"}
                    </span>
                  )}
                  {r.outcome === "already" && (
                    <span className="text-muted-foreground">
                      already has{" "}
                      <span className="font-mono text-foreground">
                        {r.existingName || result.normalizedName}
                      </span>
                      {r.existingDefault !== undefined && (
                        <>
                          {" "}
                          · default &quot;{r.existingDefault}&quot;
                        </>
                      )}
                    </span>
                  )}
                  {r.outcome === "conflict" && (
                    <span className="text-warning">{r.reason || "name can't be used"}</span>
                  )}
                  {r.outcome === "error" && (
                    <span className="text-danger">{r.reason || "failed"}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {result.results.length > shown.length && (
        <button
          type="button"
          className="pv-btn-ghost mt-2 text-xs"
          onClick={() => setOpen(true)}
        >
          Show all {result.results.length}
        </button>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "success" | "danger" | "warning";
}) {
  return (
    <div className="rounded-xl border border-border p-2.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div
        className={`mt-0.5 text-lg font-semibold tabular-nums ${
          tone === "success"
            ? "text-success"
            : tone === "danger"
              ? "text-danger"
              : tone === "warning"
                ? "text-warning"
                : ""
        }`}
      >
        {formatNumber(value)}
      </div>
    </div>
  );
}
