"use client";

import { useMemo, useRef, useState } from "react";
import type { Workspace } from "@/lib/plusvibe-types";
import {
  EVENT_TYPES,
  SYSTEM_ALERT,
  SYSTEM_ALERTS,
  emptyWebhookConfig,
  validateWebhookConfig,
  type WebhookConfig,
} from "@/lib/webhooks/config";
import {
  addWebhookToWorkspaces,
  ApiClientError,
  type BulkWebhookResponse,
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
