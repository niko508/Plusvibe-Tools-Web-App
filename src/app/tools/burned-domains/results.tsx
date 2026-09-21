"use client";

import { useMemo, useState } from "react";
import type { BurnedJob } from "@/lib/jobs/burned-types";
import { ESP_LABELS, NOUNS, countNoun, levelOf } from "@/lib/burned/settings";
import { copyText, csvName, toCsv, verdictText, type ScanRow, type Verdict } from "@/lib/burned/scan";
import { copyToClipboard } from "@/lib/clipboard";
import { formatNumber } from "@/lib/format";
import { StatCard } from "@/components/stat-card";
import { RemoveJobButton, Spinner } from "@/components/ui";
import { AlertIcon, CheckIcon, CopyIcon, DownloadIcon, FireIcon } from "@/components/icons";

// One scan's results: what it found, and the list ready to take away.

const VERDICT_META: Record<Verdict, { label: string; className: string }> = {
  burned: { label: "burned", className: "bg-danger/10 text-danger" },
  ok: { label: "ok", className: "bg-success/10 text-success" },
  quiet: { label: "too quiet", className: "bg-muted text-muted-foreground" },
};

type Filter = "burned" | "all";

export function ResultsCard({
  job,
  onAbort,
  onRemove,
}: {
  job: BurnedJob;
  onAbort: () => void;
  onRemove: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("burned");
  const [copied, setCopied] = useState(false);
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
        <div className="overflow-x-auto rounded-xl border border-border">
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
      ) : (
        <p className="rounded-xl border border-border px-3 py-6 text-center text-sm text-muted-foreground">
          {running
            ? "Scanning…"
            : filter === "burned"
              ? `Nothing is under ${job.thresholds.replyOooPct}% reply (OOO) with ${formatNumber(job.thresholds.minSends)}+ sends in this window.`
              : "Nothing was judged."}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {running ? (
          <button type="button" className="pv-btn-ghost" onClick={onAbort}>
            Stop scan
          </button>
        ) : (
          <RemoveJobButton onRemove={onRemove} />
        )}
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
