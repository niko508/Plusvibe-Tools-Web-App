"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ApiClientError,
  cancelOutreachSwitch,
  deleteOutreachSwitch,
  listOutreachSwitches,
  runOutreachSwitchNow,
} from "@/lib/api-client";
import type { ScheduledSwitch, SwitchStatus } from "@/lib/jobs/outreach-schedule-types";
import { CATEGORY_LABELS } from "@/lib/start-outreach/categories";
import { daysUntil, describeDue } from "@/lib/start-outreach/schedule";
import { formatNumber } from "@/lib/format";
import { EmptyState, Spinner } from "@/components/ui";
import { AlertIcon, ClockIcon, RefreshIcon } from "@/components/icons";

// Every booked week 2 switch: which workspace, when it lands, what kinds of
// inbox it covers and how many.
//
// A switch runs on the server at six in the morning whether or not anyone is
// here, so this is the only place it can be seen before it happens — which is
// why it says what it will do rather than only that something is scheduled.

const POLL_MS = 30_000;

const STATUS_META: Record<SwitchStatus, { label: string; className: string }> = {
  scheduled: { label: "Scheduled", className: "bg-accent/10 text-accent" },
  running: { label: "Switching", className: "bg-accent/10 text-accent" },
  done: { label: "Done", className: "bg-success/10 text-success" },
  error: { label: "Finished with problems", className: "bg-warning/10 text-warning" },
  cancelled: { label: "Cancelled", className: "bg-muted text-muted-foreground" },
};

export function ScheduledPanel() {
  const [rows, setRows] = useState<ScheduledSwitch[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      const { switches } = await listOutreachSwitches();
      setRows(switches);
      setNow(Date.now());
      setLoaded(true);
    } catch {
      // a failed poll is not worth a banner
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof ApiClientError || err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  };

  const pending = rows.filter((r) => r.status === "scheduled" || r.status === "running");

  return (
    <div className="pv-card space-y-3 p-4 sm:p-5" data-scheduled>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Scheduled</h2>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>
            {pending.length === 0
              ? "Nothing waiting"
              : `${formatNumber(pending.length)} waiting · ${formatNumber(
                  pending.reduce((n, r) => n + r.totalInboxes, 0)
                )} inboxes`}
          </span>
          <button type="button" className="pv-btn-ghost text-xs" onClick={() => void refresh()} data-refresh-scheduled>
            <RefreshIcon size={13} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <p className="flex gap-1.5 text-xs text-danger">
          <AlertIcon size={13} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </p>
      )}

      {!loaded ? (
        <div className="h-20 animate-pulse rounded-xl bg-muted" />
      ) : rows.length === 0 ? (
        <EmptyState icon={<ClockIcon />} title="No week 2 switches booked">
          A batch books one when it runs. It lands seven days later, early morning, whether or not this tab is open.
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Workspace</th>
                <th className="px-3 py-2 text-left font-medium">Switches on</th>
                <th className="px-3 py-2 text-left font-medium">Kinds of inbox</th>
                <th className="px-3 py-2 text-right font-medium">Inboxes</th>
                <th className="px-3 py-2 text-right font-medium">State</th>
                <th className="px-3 py-2 text-right font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => {
                const meta = STATUS_META[r.status];
                const waiting = r.status === "scheduled";
                const switched = r.categories.reduce((n, c) => n + (c.updated ?? 0), 0);
                return (
                  <tr key={r.id} className="hover:bg-muted/40" data-switch={r.id}>
                    <td className="px-3 py-2">
                      <div className="truncate font-medium" title={r.workspaceName}>
                        {r.workspaceName}
                      </div>
                      {r.errors.length > 0 && (
                        <div className="text-[11px] text-warning">{r.errors[0]}</div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="text-xs">{describeDue(r.dueAt)}</div>
                      {waiting && (
                        <div className="text-[11px] text-muted-foreground">
                          {(() => {
                            const d = daysUntil(r.dueAt, now);
                            return d === 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`;
                          })()}
                        </div>
                      )}
                      {r.ranAt && (
                        <div className="text-[11px] text-muted-foreground">
                          ran {new Date(r.ranAt).toLocaleString()}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {r.categories.map((c) => (
                          <span key={c.category} className="pv-chip text-[11px]">
                            {CATEGORY_LABELS[c.category]}
                            <span className="ml-1 font-medium">{formatNumber(c.emails.length)}</span>
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatNumber(r.totalInboxes)}
                      {!waiting && r.status !== "cancelled" && (
                        <div className="text-[11px] text-muted-foreground">{formatNumber(switched)} switched</div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.className}`}>
                        {r.status === "running" && <Spinner size={10} />} {meta.label}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex justify-end gap-1.5">
                        {waiting && (
                          <>
                            <button
                              type="button"
                              className="pv-btn-ghost text-[11px]"
                              disabled={busy === r.id}
                              onClick={() => void act(r.id, () => runOutreachSwitchNow(r.id))}
                              data-run-now
                              title="Apply week 2 now instead of waiting for its morning"
                            >
                              Switch now
                            </button>
                            <button
                              type="button"
                              className="pv-btn-ghost text-[11px]"
                              disabled={busy === r.id}
                              onClick={() => void act(r.id, () => cancelOutreachSwitch(r.id))}
                              data-cancel-switch
                            >
                              Cancel
                            </button>
                          </>
                        )}
                        {!waiting && r.status !== "running" && (
                          <button
                            type="button"
                            className="pv-btn-ghost text-[11px]"
                            disabled={busy === r.id}
                            onClick={() => void act(r.id, () => deleteOutreachSwitch(r.id))}
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
