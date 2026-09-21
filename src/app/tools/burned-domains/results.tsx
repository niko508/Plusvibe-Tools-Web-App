"use client";

import { useEffect, useMemo, useState } from "react";
import type { BurnedJob } from "@/lib/jobs/burned-types";
import type { BurnedRemovalJob } from "@/lib/jobs/burned-removal-types";
import { ESP_LABELS, NOUNS, countNoun, levelOf } from "@/lib/burned/settings";
import { copyText, csvName, toCsv, verdictText, type ScanRow, type Verdict } from "@/lib/burned/scan";
import { copyToClipboard } from "@/lib/clipboard";
import { formatNumber } from "@/lib/format";
import { DEFAULT_SHEET_URL } from "@/lib/jobs/azure-warmup-types";
import { useSheetConfig } from "@/lib/use-sheet-config";
import { StatCard } from "@/components/stat-card";
import { RemoveJobButton, Spinner, TableDisclosure } from "@/components/ui";
import { AlertIcon, CheckIcon, CopyIcon, DownloadIcon, FireIcon, TrashIcon } from "@/components/icons";
import { RemovalCard } from "./removal-card";

// One scan's results: what it found, and the list ready to take away.

const VERDICT_META: Record<Verdict, { label: string; className: string }> = {
  burned: { label: "burned", className: "bg-danger/10 text-danger" },
  ok: { label: "ok", className: "bg-success/10 text-success" },
  quiet: { label: "too quiet", className: "bg-muted text-muted-foreground" },
};

type Filter = "burned" | "all";

/**
 * Above this many rows the list starts folded away.
 *
 * Decided from the scan's TOTAL rows, not the filtered ones, so switching
 * between Burned and Everything never makes the table appear or vanish
 * underneath you.
 */
const FOLD_ABOVE = 25;

export function ResultsCard({
  job,
  removals,
  removalBusy,
  removalBlocked,
  onAbort,
  onRemove,
  onStartRemoval,
  onAbortRemoval,
  onDeleteRemoval,
}: {
  job: BurnedJob;
  /** Removal runs started from this scan, newest first. */
  removals: BurnedRemovalJob[];
  removalBusy: boolean;
  /** A removal is running somewhere — only one at a time is allowed. */
  removalBlocked: boolean;
  onAbort: () => void;
  onRemove: () => void;
  onStartRemoval: (sheetUrl: string) => void;
  onAbortRemoval: (id: string) => void;
  onDeleteRemoval: (id: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>("burned");
  const [copied, setCopied] = useState(false);
  // null until someone decides for themselves; the default then follows the
  // size of the list rather than overriding what they picked.
  const [listOpen, setListOpen] = useState<boolean | null>(null);
  const running = job.status === "running";

  const rows = useMemo(() => job.rows ?? [], [job.rows]);
  const burned = useMemo(() => rows.filter((r) => r.verdict === "burned"), [rows]);
  const shown = filter === "burned" ? burned : rows;
  const level = levelOf(job.esp);
  const noun = NOUNS[level];
  const quiet = rows.filter((r) => r.verdict === "quiet");
  // Rows the OOO bar would have burned, kept because real replies cleared
  // their own bar. Worth its own number: it is the new rule doing its job.
  const rescued = rows.filter((r) => r.rescued).length;
  const errors = job.errors ?? [];
  const open = listOpen ?? rows.length <= FOLD_ABOVE;

  async function handleCopy() {
    if (await copyToClipboard(copyText(shown))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  function handleDownload() {
    const blob = new Blob([toCsv(shown)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = csvName(job.esp, job.end);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <div className="pv-card space-y-4 p-4 sm:p-5" data-job={job.id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${statusClass(job.status)}`}>
            {running && <Spinner size={10} />} {statusLabel(job.status)}
          </span>
          <span className="truncate text-sm font-medium">{job.label}</span>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          under {job.thresholds.replyOooPct}% reply (OOO) and under {job.thresholds.replyPct}% reply, on{" "}
          {formatNumber(job.thresholds.minSends)}+ sends
        </span>
      </div>

      {/* Progress */}
      <div>
        <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {job.progress.workspacesDone} of {job.progress.workspacesTotal || "…"} workspaces ·{" "}
            {formatNumber(job.progress.inboxesRead)} {ESP_LABELS[job.esp]} inbox
            {job.progress.inboxesRead === 1 ? "" : "es"} read
          </span>
          <span className="tabular-nums">
            {job.progress.workspacesTotal > 0
              ? `${Math.round((job.progress.workspacesDone / job.progress.workspacesTotal) * 100)}%`
              : ""}
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-accent transition-all duration-300"
            style={{
              width: `${job.progress.workspacesTotal > 0 ? Math.round((job.progress.workspacesDone / job.progress.workspacesTotal) * 100) : 0}%`,
            }}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label={`${noun.many[0].toUpperCase()}${noun.many.slice(1)} judged`} value={formatNumber(job.progress.scanned)} sub={`${ESP_LABELS[job.esp]} only`} />
        <StatCard
          label="Burned"
          value={formatNumber(burned.length)}
          sub={`under both bars${rescued > 0 ? ` · ${formatNumber(rescued)} kept on real replies` : ""}`}
          health={burned.length > 0 ? "bad" : "good"}
        />
        <StatCard
          label="Too quiet to judge"
          value={formatNumber(quiet.length)}
          sub={`under ${formatNumber(job.thresholds.minSends)} sends, or no figures`}
        />
        <StatCard label="Still pulling replies" value={formatNumber(rows.filter((r) => r.verdict === "ok").length)} sub="left alone" />
      </div>

      {errors.length > 0 && (
        <div className="space-y-1.5">
          {errors.slice(0, 3).map((e, i) => (
            <p key={i} className="flex gap-1.5 text-xs text-warning">
              <AlertIcon size={13} className="mt-0.5 shrink-0" />
              <span>{e}</span>
            </p>
          ))}
          {errors.length > 3 && <p className="text-xs text-muted-foreground">+{errors.length - 3} more</p>}
        </div>
      )}

      {/* The list */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5 text-xs" role="radiogroup" aria-label="Which rows to show">
          {(
            [
              ["burned", `Burned · ${formatNumber(burned.length)}`],
              ["all", `Everything · ${formatNumber(rows.length)}`],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={filter === key}
              className={`pv-chip ${filter === key ? "pv-chip-active" : "hover:text-foreground"}`}
              onClick={() => setFilter(key)}
              data-filter={key}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="pv-btn-ghost text-xs disabled:opacity-50" disabled={shown.length === 0} onClick={handleCopy} data-copy>
            {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
            {copied ? "Copied!" : `Copy ${countNoun(shown.length, job.esp)}`}
          </button>
          <button type="button" className="pv-btn-ghost text-xs disabled:opacity-50" disabled={shown.length === 0} onClick={handleDownload} data-csv>
            <DownloadIcon size={14} />
            CSV
          </button>
        </div>
      </div>

      {shown.length > 0 ? (
        <TableDisclosure
          open={open}
          onToggle={() => setListOpen(!open)}
          label={
            filter === "burned"
              ? `${formatNumber(shown.length)} burned ${shown.length === 1 ? noun.one : noun.many}`
              : `${countNoun(shown.length, job.esp)} judged`
          }
        >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">{noun.one[0].toUpperCase()}{noun.one.slice(1)}</th>
                <th className="px-3 py-2 text-left font-medium">Workspace</th>
                <th className="px-3 py-2 text-right font-medium">Sent</th>
                <th className="px-3 py-2 text-right font-medium">Contacted</th>
                <th className="px-3 py-2 text-right font-medium">Replies</th>
                <th className="px-3 py-2 text-right font-medium">Reply %</th>
                <th className="px-3 py-2 text-right font-medium">Reply % (OOO)</th>
                <th className="px-3 py-2 text-right font-medium">Verdict</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {shown.slice(0, 500).map((r) => (
                <Row key={`${r.workspaceId}-${r.name}`} row={r} showInboxes={level === "domain"} />
              ))}
            </tbody>
          </table>
          {shown.length > 500 && (
            <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
              Showing the first 500 of {formatNumber(shown.length)}. Copy and CSV take all of them.
            </p>
          )}
        </div>
        </TableDisclosure>
      ) : (
        <p className="rounded-xl border border-border px-3 py-6 text-center text-sm text-muted-foreground">
          {running
            ? "Scanning…"
            : filter === "burned"
              ? `Nothing is under ${job.thresholds.replyOooPct}% reply (OOO) with ${formatNumber(job.thresholds.minSends)}+ sends in this window.`
              : "Nothing was judged."}
        </p>
      )}

      {!running && burned.length > 0 && (
        <RemovalPanel
          job={job}
          burned={burned.length}
          busy={removalBusy}
          blocked={removalBlocked}
          onStart={onStartRemoval}
        />
      )}

      {removals.map((r) => (
        <RemovalCard
          key={r.id}
          job={r}
          onAbort={() => onAbortRemoval(r.id)}
          onRemove={() => onDeleteRemoval(r.id)}
        />
      ))}

      <div className="flex flex-wrap items-center gap-2">
        {running ? (
          <button type="button" className="pv-btn-ghost" onClick={onAbort}>
            Stop scan
          </button>
        ) : (
          <RemoveJobButton onRemove={onRemove} label="Remove this scan" />
        )}
      </div>
    </div>
  );
}

/**
 * The last step: record the burned rows in the sheet, then delete them.
 *
 * Opening it first, rather than acting on the click, is deliberate — this
 * deletes mailboxes in Plusvibe and cannot be undone, so the exact steps and
 * the count are in front of someone before they confirm.
 */
function RemovalPanel({
  job,
  burned,
  busy,
  blocked,
  onStart,
}: {
  job: BurnedJob;
  burned: number;
  busy: boolean;
  blocked: boolean;
  onStart: (sheetUrl: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [sheetUrl, setSheetUrl] = useState(DEFAULT_SHEET_URL);
  const { config } = useSheetConfig();
  const google = job.esp === "google";

  useEffect(() => {
    if (config?.url) setSheetUrl(config.url);
  }, [config]);

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
        <button
          type="button"
          className="pv-btn-primary disabled:opacity-50"
          disabled={blocked || busy}
          onClick={() => setOpen(true)}
          data-open-removal
        >
          <TrashIcon size={16} />
          Remove Inboxes &amp; Domains
        </button>
        <span className="text-xs text-muted-foreground">
          {blocked
            ? "A removal is already running — let it finish or stop it first."
            : `Records the ${formatNumber(burned)} burned ${
                burned === 1 ? NOUNS[levelOf(job.esp)].one : NOUNS[levelOf(job.esp)].many
              } in the Email Infrastructure sheet, then deletes their inboxes in Plusvibe.`}
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-xl border border-danger/30 bg-danger/5 p-4" data-removal-panel>
      <div className="text-sm font-medium">
        Remove {formatNumber(burned)} burned {burned === 1 ? NOUNS[levelOf(job.esp)].one : NOUNS[levelOf(job.esp)].many}?
      </div>
      <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
        {google ? (
          <>
            <li>Each address is added to 🛑 Google Inboxes to Cancel, under Email Address. Tenant / Inbox Source is left blank.</li>
            <li>Then each inbox is deleted in Plusvibe.</li>
            <li>📋 Domains is left alone — the domain&apos;s other mailboxes may still be fine.</li>
          </>
        ) : (
          <>
            <li>Each domain is found in 📋 Domains and its Status set to Not Active.</li>
            <li>Its Tenant Email Address and Tenant / Inbox Source are read from that row and added to 🚯 Tenants to Cancel.</li>
            <li>Then every Microsoft inbox on the domain is deleted in Plusvibe.</li>
          </>
        )}
      </ol>
      <p className="text-xs text-muted-foreground">
        Columns are found by name, so reordering the sheet is fine. Anything the sheet could not record is left alone in
        Plusvibe and reported, so fixing the sheet and running this again picks it up. Deleting inboxes cannot be undone.
      </p>
      <div>
        <label className="mb-1.5 block text-xs font-medium text-muted-foreground" htmlFor={`sheet-${job.id}`}>
          Email Infrastructure sheet
        </label>
        <input
          id={`sheet-${job.id}`}
          type="url"
          className="pv-input text-sm"
          value={sheetUrl}
          onChange={(e) => setSheetUrl(e.target.value)}
          placeholder={DEFAULT_SHEET_URL}
          aria-label="Email Infrastructure sheet"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="pv-btn-primary disabled:opacity-50"
          disabled={busy || !sheetUrl.trim()}
          onClick={() => onStart(sheetUrl.trim())}
          data-confirm-removal
        >
          {busy ? <Spinner size={14} /> : <TrashIcon size={14} />}
          Yes, remove {formatNumber(burned)}
        </button>
        <button type="button" className="pv-btn-ghost text-xs" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
        <span className="text-xs text-muted-foreground">It keeps going if you close this tab.</span>
      </div>
    </div>
  );
}

function Row({ row, showInboxes }: { row: ScanRow; showInboxes: boolean }) {
  const meta = VERDICT_META[row.verdict];
  return (
    <tr className="hover:bg-muted/40">
      <td className="px-3 py-2">
        <div className="truncate font-mono text-xs" title={row.name}>
          {row.name}
        </div>
        {showInboxes && (
          <div className="text-[11px] text-muted-foreground">
            {formatNumber(row.inboxes)} inbox{row.inboxes === 1 ? "" : "es"}
          </div>
        )}
      </td>
      <td className="truncate px-3 py-2 text-xs text-muted-foreground" title={row.workspaceName}>
        {row.workspaceName}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.sent)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.contacted)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.replies + row.oooReplies)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{row.replyRate}%</td>
      <td className="px-3 py-2 text-right font-medium tabular-nums">{row.replyRateOoo}%</td>
      <td className="px-3 py-2 text-right">
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.className}`} title={verdictText(row)}>
          {row.verdict === "burned" && <FireIcon size={11} className="mr-0.5 inline" />}
          {row.rescued ? "ok · replying" : meta.label}
        </span>
      </td>
    </tr>
  );
}

function statusLabel(s: BurnedJob["status"]): string {
  return { running: "Scanning", done: "Done", aborted: "Stopped", interrupted: "Interrupted", error: "Finished with problems" }[s];
}

function statusClass(s: BurnedJob["status"]): string {
  return {
    running: "bg-accent/10 text-accent",
    done: "bg-success/10 text-success",
    aborted: "bg-muted text-muted-foreground",
    interrupted: "bg-warning/10 text-warning",
    error: "bg-warning/10 text-warning",
  }[s];
}
