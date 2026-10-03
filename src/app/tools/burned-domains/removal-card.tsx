"use client";

import { useMemo, useState } from "react";
import type { BurnedRemovalJob, PhaseState } from "@/lib/jobs/burned-removal-types";
import { ESP_LABELS, NOUNS, levelOf } from "@/lib/burned/settings";
import { inboxCount, type TargetResult, type TargetState } from "@/lib/burned/removal";
import { formatNumber } from "@/lib/format";
import { RemoveJobButton, Spinner, TableDisclosure } from "@/components/ui";
import { AlertIcon, CheckIcon, SheetIcon, TrashIcon } from "@/components/icons";

// What a "Remove Inboxes & Domains" run is doing, as it does it.
//
// Two phases shown separately because they mean different things: the sheet
// is the record of what still has to be cancelled, and Plusvibe is the
// mailboxes themselves. A row that was recorded but deliberately not deleted
// is the case worth seeing, so it gets its own count and its own reason.

const STATE_META: Record<TargetState, { label: string; className: string }> = {
  pending: { label: "waiting", className: "bg-muted text-muted-foreground" },
  queued: { label: "in the sheet", className: "bg-accent/10 text-accent" },
  deleting: { label: "deleting", className: "bg-accent/10 text-accent" },
  done: { label: "removed", className: "bg-success/10 text-success" },
  skipped: { label: "left alone", className: "bg-warning/10 text-warning" },
  error: { label: "failed", className: "bg-danger/10 text-danger" },
};

/** Above this many rows the list starts folded away. */
const FOLD_ABOVE = 25;

export function RemovalCard({
  job,
  onAbort,
  onRemove,
}: {
  job: BurnedRemovalJob;
  onAbort: () => void;
  onRemove: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  // null until someone decides for themselves.
  const [listOpen, setListOpen] = useState<boolean | null>(null);
  const running = job.status === "running";
  const rows = useMemo(() => job.rows ?? [], [job.rows]);
  const noun = NOUNS[levelOf(job.esp)];
  const errors = job.errors ?? [];

  const skipped = rows.filter((r) => r.state === "skipped");
  const failed = rows.filter((r) => r.state === "error");
  // Anything that did not go cleanly is what someone opened this card for, so
  // it is what the table shows until they ask for the rest.
  const attention = [...failed, ...skipped];
  const shown = showAll || attention.length === 0 ? rows : attention;

  const pct =
    job.progress.total > 0 ? Math.round((job.progress.removed / job.progress.total) * 100) : 0;
  // The rows that need attention are the point of the card, so a run with any
  // of those opens however long the full list is.
  const open = listOpen ?? shown.length <= FOLD_ABOVE;

  return (
    <div className="rounded-xl border border-border bg-muted/20 p-4" data-removal={job.id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${statusClass(job.status)}`}>
            {running && <Spinner size={10} />} {statusLabel(job.status)}
          </span>
          <span className="truncate text-sm font-medium">{job.label}</span>
        </div>
        <a
          className="shrink-0 text-xs text-muted-foreground underline-offset-2 hover:underline"
          href={`https://docs.google.com/spreadsheets/d/${job.spreadsheetId}/edit`}
          target="_blank"
          rel="noreferrer"
        >
          Open the sheet
        </a>
      </div>

      {/* The two phases */}
      <div className="mt-3 grid gap-2 sm:grid-cols-2" data-phases>
        <Phase
          icon={<SheetIcon size={14} />}
          title="Email Infrastructure sheet"
          state={job.phaseStates.sheet}
          lines={sheetLines(job)}
        />
        <Phase
          icon={<TrashIcon size={14} />}
          title="Plusvibe inboxes"
          state={job.phaseStates.plusvibe}
          lines={[
            `${formatNumber(job.progress.inboxesDeleted)} deleted`,
            `${formatNumber(job.progress.removed)} of ${formatNumber(job.progress.total)} ${noun.many} done`,
          ]}
        />
      </div>

      <div className="mt-3">
        <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {job.phase === "sheet"
              ? "Writing the sheet — nothing is deleted until it is recorded."
              : job.phase === "plusvibe"
                ? `Deleting ${ESP_LABELS[job.esp]} inboxes, workspace by workspace.`
                : `${inboxCount(job.progress.inboxesDeleted)} deleted.`}
          </span>
          <span className="tabular-nums">{pct}%</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-accent transition-all duration-300" style={{ width: `${pct}%` }} />
        </div>
      </div>

      {skipped.length > 0 && (
        <p className="mt-3 flex gap-1.5 text-xs text-warning" data-left-alone>
          <AlertIcon size={13} className="mt-0.5 shrink-0" />
          <span>
            {formatNumber(skipped.length)} {skipped.length === 1 ? noun.one : noun.many} could not be recorded in the
            sheet, so their inboxes were left alone. Fix the sheet and run this again — nothing here is undone by
            repeating it.
          </span>
        </p>
      )}

      {errors.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {errors.slice(0, 3).map((e, i) => (
            <p key={i} className="flex gap-1.5 text-xs text-warning">
              <AlertIcon size={13} className="mt-0.5 shrink-0" />
              <span>{e}</span>
            </p>
          ))}
          {errors.length > 3 && (
            <p className="text-xs text-muted-foreground">+{errors.length - 3} more</p>
          )}
        </div>
      )}

      {rows.length > 0 && (
        <div className="mt-3">
        <TableDisclosure
          open={open}
          onToggle={() => setListOpen(!open)}
          label={`${formatNumber(shown.length)} ${shown.length === 1 ? noun.one : noun.many}${
            shown.length < rows.length ? " needing attention" : ""
          }`}
        >
        <div className="overflow-x-auto bg-background">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">
                  {noun.one[0].toUpperCase()}
                  {noun.one.slice(1)}
                </th>
                <th className="px-3 py-2 text-left font-medium">Workspace</th>
                {job.esp === "microsoft" && <th className="px-3 py-2 text-left font-medium">Tenant</th>}
                <th className="px-3 py-2 text-right font-medium">Inboxes</th>
                <th className="px-3 py-2 text-right font-medium">State</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {shown.slice(0, 200).map((r) => (
                <RemovalRow key={`${r.workspaceId}-${r.name}`} row={r} showTenant={job.esp === "microsoft"} />
              ))}
            </tbody>
          </table>
          {attention.length > 0 && (
            <button
              type="button"
              className="w-full border-t border-border px-3 py-2 text-left text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setShowAll((v) => !v)}
              data-toggle-rows
            >
              {showAll
                ? `Show only what needs attention · ${formatNumber(attention.length)}`
                : `Show everything · ${formatNumber(rows.length)}`}
            </button>
          )}
        </div>
        </TableDisclosure>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {running ? (
          <button type="button" className="pv-btn-ghost text-xs" onClick={onAbort} data-abort-removal>
            Stop removal
          </button>
        ) : (
          <RemoveJobButton onRemove={onRemove} label="Remove this run" />
        )}
      </div>
    </div>
  );
}

function RemovalRow({ row, showTenant }: { row: TargetResult; showTenant: boolean }) {
  const meta = STATE_META[row.state];
  return (
    <tr className="hover:bg-muted/40">
      <td className="px-3 py-2">
        <div className="truncate font-mono text-xs" title={row.name}>
          {row.name}
        </div>
        {row.note && <div className="text-[11px] text-muted-foreground">{row.note}</div>}
      </td>
      <td className="truncate px-3 py-2 text-xs text-muted-foreground" title={row.workspaceName}>
        {row.workspaceName}
      </td>
      {showTenant && (
        <td className="truncate px-3 py-2 font-mono text-[11px] text-muted-foreground" title={row.tenant}>
          {row.tenant ?? "—"}
          {row.tenantAlready && <span className="ml-1 text-[10px]">(already queued)</span>}
        </td>
      )}
      <td className="px-3 py-2 text-right tabular-nums">
        {formatNumber(row.inboxesDeleted)}
        {row.inboxesFound > row.inboxesDeleted && (
          <span className="text-muted-foreground"> / {formatNumber(row.inboxesFound)}</span>
        )}
      </td>
      <td className="px-3 py-2 text-right">
        <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.className}`}>
          {meta.label}
        </span>
      </td>
    </tr>
  );
}

function Phase({
  icon,
  title,
  state,
  lines,
}: {
  icon: React.ReactNode;
  title: string;
  state: PhaseState;
  lines: string[];
}) {
  return (
    <div className="rounded-lg border border-border bg-background px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <span className={phaseClass(state)}>{state === "running" ? <Spinner size={13} /> : icon}</span>
        <span className="truncate">{title}</span>
        {state === "done" && <CheckIcon size={13} className="text-success" />}
        {(state === "error" || state === "skipped") && <AlertIcon size={13} className="text-warning" />}
      </div>
      <div className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
        {lines.map((l, i) => (
          <div key={i}>{l}</div>
        ))}
      </div>
    </div>
  );
}

function sheetLines(job: BurnedRemovalJob): string[] {
  const s = job.sheet;
  if (job.esp === "google") {
    return [
      `${formatNumber(s.inboxesQueued)} added to 🛑 Google Inboxes to Cancel`,
      s.inboxesAlready > 0 ? `${formatNumber(s.inboxesAlready)} were already there` : "source left blank",
    ];
  }
  return [
    `${formatNumber(s.statusUpdated)} marked Not Active${
      s.statusAlready > 0 ? ` · ${formatNumber(s.statusAlready)} already were` : ""
    }`,
    `${formatNumber(s.tenantsQueued)} added to 🚯 Tenants to Cancel${
      s.tenantsAlready > 0 ? ` · ${formatNumber(s.tenantsAlready)} already queued` : ""
    }`,
  ];
}

function phaseClass(state: PhaseState): string {
  return {
    pending: "text-muted-foreground",
    running: "text-accent",
    done: "text-success",
    skipped: "text-warning",
    error: "text-warning",
  }[state];
}

function statusLabel(s: BurnedRemovalJob["status"]): string {
  return {
    running: "Removing",
    done: "Done",
    aborted: "Stopped",
    interrupted: "Interrupted",
    error: "Finished with problems",
  }[s];
}

function statusClass(s: BurnedRemovalJob["status"]): string {
  return {
    running: "bg-accent/10 text-accent",
    done: "bg-success/10 text-success",
    aborted: "bg-muted text-muted-foreground",
    interrupted: "bg-warning/10 text-warning",
    error: "bg-warning/10 text-warning",
  }[s];
}
