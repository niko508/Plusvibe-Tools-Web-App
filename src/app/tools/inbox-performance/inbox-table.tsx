"use client";

import type { InboxRow, SortKey, SortState } from "./types";
import {
  formatNumber,
  formatPercent,
  replyRateHeat,
  replyRateOooHeat,
  bounceRateHeat,
} from "@/lib/format";
import { sumTotals } from "@/lib/inbox-performance/metrics";
import { Spinner } from "@/components/ui";
import { AlertIcon } from "@/components/icons";
import { PROVIDER_BADGE, providerShort } from "../domain-performance/providers";

type Heat = { text: string; bg: string };

/** Numeric cells: tight padding, never wrapped, so ten columns fit the card. */
const NUM = "whitespace-nowrap px-2.5 py-3 text-right tabular-nums";

function HeatCell({ value, heat }: { value: number; heat: Heat }) {
  return (
    <td className={NUM}>
      <span
        className="inline-block rounded-md px-2 py-0.5 tabular-nums"
        style={{ color: heat.text, backgroundColor: heat.bg }}
      >
        {formatPercent(value)}
      </span>
    </td>
  );
}

interface Props {
  rows: InboxRow[];
  sort: SortState;
  onSort: (key: SortKey) => void;
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** Global view: a column for the workspace each inbox belongs to. */
  showWorkspace: boolean;
}

interface Column {
  key: SortKey;
  label: string;
  align: "left" | "right";
}

const COLUMNS: Column[] = [
  { key: "inbox", label: "Inbox", align: "left" },
  { key: "workspace", label: "Workspace", align: "left" },
  { key: "provider", label: "Provider", align: "left" },
  { key: "sent", label: "Sent", align: "right" },
  { key: "contacted", label: "Contacted", align: "right" },
  { key: "replies", label: "Replies", align: "right" },
  { key: "reply_rate", label: "True reply %", align: "right" },
  { key: "reply_rate_ooo", label: "Reply % OOO", align: "right" },
  { key: "pos_reply_rate", label: "Pos %", align: "right" },
  { key: "bounce_rate", label: "Bounce %", align: "right" },
];

export function metricValue(row: InboxRow, key: SortKey): number | string {
  if (key === "inbox") return row.email;
  if (key === "workspace") return row.workspaceName;
  if (key === "provider") return providerShort(row.provider);
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
    case "reply_rate_ooo":
      return r.replyRateOoo;
    case "pos_reply_rate":
      return r.posRate;
    case "bounce_rate":
      return r.bounceRate;
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

export function InboxTable({ rows, sort, onSort, selected, onSelect, showWorkspace }: Props) {
  const sorted = sortRows(rows, sort);
  const columns = COLUMNS.filter((c) => showWorkspace || c.key !== "workspace");
  const totals = sumTotals(rows.filter((r) => r.rates).map((r) => r.rates!));

  return (
    <div className="pv-card overflow-hidden">
      <div className="pv-scroll overflow-x-auto">
        <table className="w-full min-w-[880px] text-sm">
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
                      <span className="w-2 text-[10px]">{active ? (sort.dir === "asc" ? "▲" : "▼") : ""}</span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <InboxTableRow
                key={row.id}
                row={row}
                selected={selected === row.id}
                onSelect={onSelect}
                showWorkspace={showWorkspace}
              />
            ))}
          </tbody>
          {totals.count > 0 && (
            <tfoot>
              <tr className="border-t border-border bg-muted/40 font-medium">
                <td className="px-3 py-3" colSpan={showWorkspace ? 3 : 2}>
                  Total · {formatNumber(totals.count)} inbox{totals.count === 1 ? "" : "es"}
                </td>
                <td className={NUM}>{formatNumber(totals.sent)}</td>
                <td className={NUM}>{formatNumber(totals.contacted)}</td>
                <td className={NUM}>{formatNumber(totals.replies)}</td>
                <HeatCell value={totals.replyRate} heat={replyRateHeat(totals.replyRate)} />
                <HeatCell value={totals.replyRateOoo} heat={replyRateOooHeat(totals.replyRateOoo)} />
                <td className={NUM}>{formatPercent(totals.posRate)}</td>
                <HeatCell value={totals.bounceRate} heat={bounceRateHeat(totals.bounceRate)} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

function InboxTableRow({
  row,
  selected,
  onSelect,
  showWorkspace,
}: {
  row: InboxRow;
  selected: boolean;
  onSelect: (id: string | null) => void;
  showWorkspace: boolean;
}) {
  const r = row.rates;
  const clickable = row.status === "done" && !!r && !!row.chart?.length;

  return (
    <tr
      onClick={() => clickable && onSelect(selected ? null : row.id)}
      className={`border-b border-border/70 transition last:border-0 ${
        clickable ? "cursor-pointer hover:bg-muted/50" : ""
      } ${selected ? "bg-accent/5" : ""}`}
    >
      <td className="px-3 py-3">
        <div className="flex items-center gap-2">
          {selected && <span className="h-4 w-0.5 shrink-0 rounded-full bg-accent" />}
          {/* Long addresses wrap here rather than pushing the numbers off the card. */}
          <span className="break-all font-medium">{row.email}</span>
          {row.accountStatus && row.accountStatus.toUpperCase() !== "ACTIVE" && (
            <span className="pv-chip py-0.5 text-[10px]" title="Account status in Plusvibe">
              {row.accountStatus.toLowerCase()}
            </span>
          )}
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
        <td className="max-w-[160px] px-3 py-3 text-muted-foreground">{row.workspaceName}</td>
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
      {r ? (
        <>
          <td className={NUM}>{formatNumber(r.sent)}</td>
          <td className={NUM}>{formatNumber(r.contacted)}</td>
          <td className={NUM}>{formatNumber(r.replies)}</td>
          <HeatCell value={r.replyRate} heat={replyRateHeat(r.replyRate)} />
          <HeatCell value={r.replyRateOoo} heat={replyRateOooHeat(r.replyRateOoo)} />
          <td className={NUM}>{formatPercent(r.posRate)}</td>
          <HeatCell value={r.bounceRate} heat={bounceRateHeat(r.bounceRate)} />
        </>
      ) : (
        <td colSpan={7} className="px-3 py-3 text-right text-xs text-muted-foreground">
          {row.status === "error" ? row.error || "Failed to load" : row.status === "loading" ? "Loading…" : "Not loaded"}
        </td>
      )}
    </tr>
  );
}
