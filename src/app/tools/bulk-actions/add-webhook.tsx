"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Workspace } from "@/lib/plusvibe-types";
import {
  EVENT_TYPES,
  SYSTEM_ALERT,
  SYSTEM_ALERTS,
  isLabelEvent,
  emptyWebhookConfig,
  validateWebhookConfig,
  type WebhookConfig,
} from "@/lib/webhooks/config";
import {
  addWebhookToWorkspaces,
  fetchLeadLabels,
  ApiClientError,
  type BulkWebhookResponse,
  type MergedLeadLabel,
} from "@/lib/api-client";
import { formatNumber } from "@/lib/format";
import { Spinner } from "@/components/ui";
import { AlertIcon, CheckIcon, RefreshIcon, ZapIcon } from "@/components/icons";

export function AddWebhook({
  workspaces,
  selected,
  loading,
}: {
  workspaces: Workspace[];
  selected: Set<string>;
  loading: boolean;
}) {
  const [config, setConfig] = useState<WebhookConfig>(emptyWebhookConfig());
  const [result, setResult] = useState<BulkWebhookResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runLock = useRef(false);

  // Lead labels are per-workspace, so they're read for exactly the workspaces
  // that are selected — a label only some of them define would create webhooks
  // that never fire in the rest.
  const [labels, setLabels] = useState<MergedLeadLabel[]>([]);
  const [labelsLoading, setLabelsLoading] = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [labelsFor, setLabelsFor] = useState<string>("");

  const chosen = useMemo(
    () =>
      workspaces
        .filter((w) => selected.has(w._id))
        .map((w) => ({ id: w._id, name: w.name })),
    [workspaces, selected]
  );

  const problems = validateWebhookConfig(config);
  const canRun = chosen.length > 0 && problems.length === 0 && !busy;
  const wantsAlerts = config.eventTypes.includes(SYSTEM_ALERT);

  function set<K extends keyof WebhookConfig>(key: K, value: WebhookConfig[K]) {
    setConfig((prev) => ({ ...prev, [key]: value }));
    setResult(null);
  }

  function toggleEvent(value: string) {
    const has = config.eventTypes.includes(value);
    set(
      "eventTypes",
      has
        ? config.eventTypes.filter((e) => e !== value)
        : [...config.eventTypes, value]
    );
  }

  function toggleAlert(value: string) {
    const has = config.alerts.includes(value);
    set(
      "alerts",
      has ? config.alerts.filter((a) => a !== value) : [...config.alerts, value]
    );
  }

  const chosenIds = chosen.map((c) => c.id).join(",");

  const loadLabels = useCallback(async () => {
    if (!chosenIds) return;
    setLabelsLoading(true);
    setError(null);
    try {
      const res = await fetchLeadLabels(chosenIds.split(","));
      setLabels(res.labels);
      setLabelsFor(chosenIds);
      if (res.failed.length > 0) {
        setError(
          `Labels could not be read for ${res.failed.length} of ${res.workspacesRequested} workspaces, so the "in all" counts below are incomplete.`
        );
      }
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Could not load labels"
      );
    } finally {
      setLabelsLoading(false);
    }
  }, [chosenIds]);

  // Labels belong to the selected workspaces, so a changed selection makes the
  // loaded list stale — and any picked label may no longer exist everywhere.
  useEffect(() => {
    if (labelsOpen && chosenIds && chosenIds !== labelsFor) void loadLabels();
  }, [labelsOpen, chosenIds, labelsFor, loadLabels]);

  // Labels chosen as events, with how many selected workspaces define each.
  const pickedLabels = config.eventTypes
    .filter(isLabelEvent)
    .map((et) => ({
      eventType: et,
      label: labels.find((l) => l.eventType === et) ?? null,
    }));
  const partialLabels = pickedLabels.filter(
    (p) => p.label && p.label.presentIn < chosen.length
  );

  async function run(dryRun: boolean) {
    if (!canRun || runLock.current) return;
    runLock.current = true;
    setBusy(true);
    setError(null);
    if (!dryRun) setResult(null);
    try {
      setResult(
        await addWebhookToWorkspaces({ workspaces: chosen, config, dryRun })
      );
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
              Webhook URL
            </label>
            <input
              type="url"
              className="pv-input font-mono text-sm"
              placeholder="https://hooks.example.com/plusvibe"
              value={config.url}
              onChange={(e) => set("url", e.target.value)}
              spellCheck={false}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Name <span className="font-normal">(optional)</span>
            </label>
            <input
              type="text"
              className="pv-input"
              placeholder="Reply notifications"
              value={config.name}
              onChange={(e) => set("name", e.target.value)}
            />
          </div>
        </div>

        <div>
          <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
            Events
          </span>
          <div className="flex flex-wrap gap-2">
            {EVENT_TYPES.map((e) => (
              <button
                key={e.value}
                type="button"
                onClick={() => toggleEvent(e.value)}
                className={`pv-chip ${
                  config.eventTypes.includes(e.value)
                    ? "pv-chip-active"
                    : "hover:text-foreground"
                }`}
              >
                {e.label}
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              Lead labels{" "}
              {pickedLabels.length > 0 && (
                <span className="text-foreground">
                  · {pickedLabels.length} selected
                </span>
              )}
            </span>
            <div className="flex items-center gap-2">
              {labelsOpen && (
                <button
                  type="button"
                  className="pv-btn-ghost text-xs"
                  onClick={loadLabels}
                  disabled={labelsLoading || chosen.length === 0}
                >
                  {labelsLoading ? <Spinner size={13} /> : <RefreshIcon size={13} />}
                  Reload
                </button>
              )}
              <button
                type="button"
                className="pv-btn-ghost text-xs"
                onClick={() => setLabelsOpen((v) => !v)}
              >
                {labelsOpen ? "Hide" : "Show labels"}
              </button>
            </div>
          </div>

          {labelsOpen && (
            <div className="mt-2">
              {chosen.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Pick some workspaces first — labels are defined per workspace.
                </p>
              ) : labelsLoading && labels.length === 0 ? (
                <div className="h-20 animate-pulse rounded-lg bg-muted" />
              ) : labels.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No labels found in the selected workspaces.
                </p>
              ) : (
                <>
                  <p className="mb-2 text-xs text-muted-foreground">
                    Read from the {formatNumber(chosen.length)} selected
                    workspace{chosen.length === 1 ? "" : "s"}. A label not
                    defined everywhere is marked — the webhook would still be
                    created there, it just would never fire.
                  </p>
                  <div className="pv-scroll max-h-56 space-y-1 overflow-y-auto">
                    {labels.map((l) => {
                      const everywhere = l.presentIn >= chosen.length;
                      return (
                        <label
                          key={l.key}
                          className="flex cursor-pointer items-start gap-2 rounded-lg px-1.5 py-1 text-xs transition hover:bg-muted/50"
                        >
                          <input
                            type="checkbox"
                            className="mt-0.5"
                            checked={config.eventTypes.includes(l.eventType)}
                            onChange={() => toggleEvent(l.eventType)}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate">
                              {l.name}
                              {l.isSystem && (
                                <span className="text-muted-foreground">
                                  {" "}
                                  · built-in
                                </span>
                              )}
                              {!everywhere && (
                                <span className="text-warning">
                                  {" "}
                                  · only in {l.presentIn} of{" "}
                                  {formatNumber(chosen.length)}
                                </span>
                              )}
                            </span>
                            <span className="block truncate font-mono text-[10px] text-muted-foreground">
                              {l.eventType}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    The mono line is the exact{" "}
                    <span className="font-mono">event_types</span> value that
                    will be sent. Plusvibe&apos;s docs don&apos;t say whether a
                    label is referenced by its key or its display name, so
                    it&apos;s worth checking one against the webhook screen in
                    Plusvibe before creating these everywhere.
                  </p>
                </>
              )}
            </div>
          )}

          {partialLabels.length > 0 && (
            <p className="mt-2 flex gap-1.5 text-xs text-warning">
              <AlertIcon size={13} className="mt-0.5 shrink-0" />
              <span>
                {partialLabels.length} selected label
                {partialLabels.length === 1 ? " isn't" : "s aren't"} defined in
                every selected workspace.
              </span>
            </p>
          )}
        </div>

        {wantsAlerts && (
          <div className="rounded-xl border border-border p-3">
            <span className="mb-2 block text-xs font-medium text-muted-foreground">
              System alerts to send ({config.alerts.length} selected)
            </span>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {SYSTEM_ALERTS.map((a) => (
                <label
                  key={a}
                  className="flex items-start gap-2 text-xs text-muted-foreground"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={config.alerts.includes(a)}
                    onChange={() => toggleAlert(a)}
                  />
                  <span className="font-mono">{a}</span>
                </label>
              ))}
            </div>
            <button
              type="button"
              className="pv-btn-ghost mt-2 text-xs"
              onClick={() =>
                set(
                  "alerts",
                  config.alerts.length === SYSTEM_ALERTS.length
                    ? []
                    : [...SYSTEM_ALERTS]
                )
              }
            >
              {config.alerts.length === SYSTEM_ALERTS.length
                ? "Clear all"
                : "Select all"}
            </button>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Signing secret <span className="font-normal">(optional)</span>
            </label>
            <input
              type="text"
              className="pv-input font-mono text-sm"
              value={config.secret}
              onChange={(e) => set("secret", e.target.value)}
              spellCheck={false}
            />
          </div>
          <div className="flex flex-col justify-end gap-1.5 pb-1">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={config.ignoreOoo}
                onChange={(e) => set("ignoreOoo", e.target.checked)}
              />
              Ignore out-of-office replies
            </label>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={config.ignoreAutomatic}
                onChange={(e) => set("ignoreAutomatic", e.target.checked)}
              />
              Ignore automatic replies
            </label>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          The webhook covers <span className="text-foreground">all campaigns</span>{" "}
          in each workspace. Campaign ids are workspace-specific, so a bulk add
          across workspaces has nothing narrower it could target.
        </p>

        {problems.length > 0 && config.url.trim() !== "" && (
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
            {busy ? <Spinner /> : <ZapIcon size={16} />}
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

      {result && <ResultCard result={result} />}
    </div>
  );
}

function ResultCard({ result }: { result: BulkWebhookResponse }) {
  const [open, setOpen] = useState(false);
  const shown = open ? result.results : result.results.slice(0, 8);

  return (
    <div className="pv-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">
          {result.dryRun ? "Preview" : "Done"}
        </h2>
        {result.dryRun && (
          <span className="text-xs text-muted-foreground">
            Nothing has been created yet.
          </span>
        )}
      </div>

      <div className="mt-3 grid grid-cols-3 gap-3">
        <Stat
          label={result.dryRun ? "Would be added" : "Added"}
          value={result.totals.added}
          tone="success"
        />
        <Stat label="Already had it" value={result.totals.already} />
        <Stat
          label="Errors"
          value={result.totals.errors}
          tone={result.totals.errors > 0 ? "danger" : undefined}
        />
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
              <tr
                key={r.workspaceId}
                className="border-b border-border/70 last:border-0"
              >
                <td className="px-3 py-2">{r.workspaceName || r.workspaceId}</td>
                <td className="px-3 py-2">
                  {r.outcome === "added" && (
                    <span className="text-success">
                      {result.dryRun ? "will be added" : "added"}
                    </span>
                  )}
                  {r.outcome === "already" && (
                    <span className="text-muted-foreground">
                      already has this URL — skipped
                    </span>
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
  tone?: "success" | "danger";
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
              : ""
        }`}
      >
        {formatNumber(value)}
      </div>
    </div>
  );
}

export { CheckIcon };
