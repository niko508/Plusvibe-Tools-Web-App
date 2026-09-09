"use client";

import { formatNumber, formatPercent } from "@/lib/format";
import { replyRateHeat } from "@/lib/format";
import { Spinner } from "@/components/ui";
import { AlertIcon } from "@/components/icons";
import { VERDICT_LABELS, type Verdict } from "@/lib/change-limits/qualify";
import { PROVIDER_BADGE, providerShort } from "../domain-performance/providers";
import type { InboxRow, SortKey, SortState } from "./types";

const NUM = "whitespace-nowrap px-2.5 py-3 text-right tabular-nums";

const VERDICT_CLASS: Record<Verdict, string> = {
  qualifies: "bg-success/10 text-success",
  "below-rate": "bg-muted text-muted-foreground",
  "too-few-sends": "bg-muted text-muted-foreground",
  "provider-skipped": "bg-muted text-muted-foreground",
  "no-stats": "bg-warning/10 text-warning",
};

const COLUMNS: { key: SortKey; label: string; align: "left" | "right" }[] = [
  { key: "inbox", label: "Inbox", align: "left" },
  { key: "workspace", label: "Workspace", align: "left" },
  { key: "provider", label: "Provider", align: "left" },
  { key: "sent", label: "Sent", align: "right" },
  { key: "contacted", label: "Contacted", align: "right" },
  { key: "replies", label: "Replies", align: "right" },
  { key: "reply_rate", label: "True reply %", align: "right" },
  { key: "verdict", label: "Verdict", align: "left" },
];

/** Sort order for the verdict column: the ones you act on first. */
const VERDICT_ORDER: Record<Verdict, number> = {
  qualifies: 0,
  "below-rate": 1,
  "too-few-sends": 2,
  "provider-skipped": 3,
  "no-stats": 4,
};

export function metricValue(row: InboxRow, key: SortKey): number | string {
  if (key === "inbox") return row.email;
  if (key === "workspace") return row.workspaceName;
  if (key === "provider") return providerShort(row.provider);
  if (key === "verdict") return row.verdict ? VERDICT_ORDER[row.verdict] : 9;
  const r = row.rates;
  if (!r) return -1; // unloaded rows sort to the bottom for numeric keys
  switch (key) {
    case "sent":
      return r.sent;
    case "contacted":
      return r.contacted;
    case "replies":
      return r.replies;
    case "reply_rate":
      return r.replyRate;
  }
}

export function sortRows(rows: InboxRow[], sort: SortState): InboxRow[] {
  const factor = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = metricValue(a, sort.key);
    const bv = metricValue(b, sort.key);
    if (typeof av === "string" || typeof bv === "string") {
      return String(av).localeCompare(String(bv)) * factor;
    }
    return (av - bv) * factor;
  });
}

interface Props {
  rows: InboxRow[];
  sort: SortState;
  onSort: (key: SortKey) => void;
  showWorkspace: boolean;
}

export function InboxTable({ rows, sort, onSort, showWorkspace }: Props) {
  const sorted = sortRows(rows, sort);
  const columns = COLUMNS.filter((c) => showWorkspace || c.key !== "workspace");

  return (
    <div className="pv-card overflow-hidden">
      <div className="pv-scroll overflow-x-auto">
        <table className="w-full min-w-[820px] text-sm">
          <thead>
            <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
              {columns.map((col) => {
                const active = sort.key === col.key;
                return (
                  <th
                    key={col.key}
                    className={`whitespace-nowrap py-3 font-medium ${
                      col.align === "right" ? "px-2.5 text-right" : "px-3 text-left"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onSort(col.key)}
                      className={`inline-flex items-center gap-1 transition hover:text-foreground ${
                        active ? "text-foreground" : ""
                      } ${col.align === "right" ? "flex-row-reverse" : ""}`}
                    >
                      {col.label}
                      <span className="w-2 text-[10px]">
                        {active ? (sort.dir === "asc" ? "▲" : "▼") : ""}
                      </span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr
                key={row.id}
                className="border-b border-border/70 transition last:border-0"
              >
                <td className="px-3 py-3">
                  <div className="flex items-center gap-2">
                    <span className="break-all font-medium">{row.email}</span>
                    {row.status === "loading" && (
                      <span className="text-muted-foreground">
                        <Spinner size={12} />
                      </span>
                    )}
                    {row.status === "error" && (
                      <span className="text-danger" title={row.error || "Failed to load"}>
                        <AlertIcon size={13} />
                      </span>
                    )}
                  </div>
                </td>
                {showWorkspace && (
                  <td className="max-w-[160px] px-3 py-3 text-muted-foreground">
                    {row.workspaceName}
                  </td>
                )}
                <td className="px-3 py-3">
                  <span
                    className={`inline-block whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium ${
                      PROVIDER_BADGE[row.provider] ?? PROVIDER_BADGE.REGULAR_ACCOUNT
                    }`}
                  >
                    {providerShort(row.provider)}
                  </span>
                </td>
                {row.rates ? (
                  <>
                    <td className={NUM}>{formatNumber(row.rates.sent)}</td>
                    <td className={NUM}>{formatNumber(row.rates.contacted)}</td>
                    <td className={NUM}>{formatNumber(row.rates.replies)}</td>
                    <td className={NUM}>
                      <span
                        className="inline-block rounded-md px-2 py-0.5 tabular-nums"
                        style={{
                          color: replyRateHeat(row.rates.replyRate).text,
                          backgroundColor: replyRateHeat(row.rates.replyRate).bg,
                        }}
                      >
                        {formatPercent(row.rates.replyRate)}
                      </span>
                    </td>
                  </>
                ) : (
                  <td colSpan={4} className="px-3 py-3 text-right text-xs text-muted-foreground">
                    {row.status === "error"
                      ? row.error || "Failed to load"
                      : row.status === "loading"
                        ? "Loading…"
                        : "Not loaded"}
                  </td>
                )}
                <td className="px-3 py-3">
                  {row.verdict && (
                    <span
                      className={`inline-block whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium ${VERDICT_CLASS[row.verdict]}`}
                      title={
                        row.threshold != null
                          ? `Measured against ${row.threshold}%`
                          : "No threshold set for this provider"
                      }
                    >
                      {VERDICT_LABELS[row.verdict]}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
