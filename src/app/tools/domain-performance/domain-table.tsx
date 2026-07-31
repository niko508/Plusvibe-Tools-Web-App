"use client";

import type { DomainRow, SortKey, SortState } from "./types";
import {
  formatNumber,
  formatPercent,
  bounceRateHealth,
  replyRateHeat,
  uniqueContacted,
} from "@/lib/format";
import { HealthDot, healthText, Spinner } from "@/components/ui";

// Heatmap-styled reply-rate cell: red → green tint by reply rate.
function ReplyHeatCell({ rate, muted }: { rate: number; muted?: boolean }) {
  const heat = replyRateHeat(rate);
  return (
    <td className="px-4 py-3 text-right tabular-nums">
      <span
        className="inline-block rounded-md px-2 py-0.5 tabular-nums"
        style={{
          color: heat.text,
          backgroundColor: heat.bg,
          opacity: muted ? 0.85 : 1,
        }}
      >
        {formatPercent(rate)}
      </span>
    </td>
  );
}
import { AlertIcon } from "@/components/icons";

interface Props {
  rows: DomainRow[];
  sort: SortState;
  onSort: (key: SortKey) => void;
  selected: string | null;
  onSelect: (domain: string | null) => void;
}

interface Column {
  key: SortKey;
  label: string;
  align: "left" | "right";
  numeric: boolean;
}

const COLUMNS: Column[] = [
  { key: "domain", label: "Domain", align: "left", numeric: false },
  { key: "mailboxes", label: "Mailboxes", align: "right", numeric: true },
  { key: "sent", label: "Sent", align: "right", numeric: true },
  { key: "contacted", label: "Contacted", align: "right", numeric: true },
  { key: "replies", label: "Replies", align: "right", numeric: true },
  { key: "reply_rate", label: "Reply %", align: "right", numeric: true },
  { key: "reply_rate_ooo", label: "Reply % (OOO)", align: "right", numeric: true },
  { key: "pos_reply_rate", label: "Pos %", align: "right", numeric: true },
  { key: "bounce_rate", label: "Bounce %", align: "right", numeric: true },
];

export function metricValue(row: DomainRow, key: SortKey): number | string {
  if (key === "domain") return row.domain;
  if (key === "mailboxes") return row.mailboxes;
  const h = row.header;
  if (!h) return -1; // unloaded rows sort to the bottom for numeric keys
  switch (key) {
    case "sent":
      return h.total_sent_count;
    case "contacted":
      return uniqueContacted(h);
    case "replies":
      return h.total_reply_count;
    case "reply_rate":
      return h.reply_rate;
    case "reply_rate_ooo":
      return h.reply_rate_with_ooo;
    case "pos_reply_rate":
      return h.pos_reply_rate;
    case "bounce_rate":
      return h.bounce_rate;
  }
}

export function sortRows(rows: DomainRow[], sort: SortState): DomainRow[] {
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

export function DomainTable({ rows, sort, onSort, selected, onSelect }: Props) {
  const sorted = sortRows(rows, sort);
  const totals = computeTotals(rows);

  return (
    <div className="pv-card overflow-hidden">
      <div className="pv-scroll overflow-x-auto">
        <table className="w-full min-w-[820px] text-sm">
          <thead>
            <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
              {COLUMNS.map((col) => {
                const active = sort.key === col.key;
                return (
                  <th
                    key={col.key}
                    className={`px-4 py-3 font-medium ${
                      col.align === "right" ? "text-right" : "text-left"
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
              <DomainTableRow
                key={row.domain}
                row={row}
                selected={selected === row.domain}
                onSelect={onSelect}
              />
            ))}
          </tbody>
          {totals.count > 0 && (
            <tfoot>
              <tr className="border-t border-border bg-muted/40 font-medium">
                <td className="px-4 py-3">
                  Total · {totals.count} domain{totals.count === 1 ? "" : "s"}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {formatNumber(totals.mailboxes)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {formatNumber(totals.sent)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {formatNumber(totals.contacted)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {formatNumber(totals.replies)}
                </td>
                <ReplyHeatCell rate={totals.replyRate} />
                <ReplyHeatCell rate={totals.replyRateOoo} muted />
                <td className="px-4 py-3 text-right tabular-nums">
                  {formatPercent(totals.posRate)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {formatPercent(totals.bounceRate)}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

function DomainTableRow({
  row,
  selected,
  onSelect,
}: {
  row: DomainRow;
  selected: boolean;
  onSelect: (domain: string | null) => void;
}) {
  const h = row.header;
  const clickable = row.status === "done" && !!h;

  return (
    <tr
      onClick={() => clickable && onSelect(selected ? null : row.domain)}
      className={`border-b border-border/70 transition last:border-0 ${
        clickable ? "cursor-pointer hover:bg-muted/50" : ""
      } ${selected ? "bg-accent/5" : ""}`}
    >
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          {selected && <span className="h-4 w-0.5 rounded-full bg-accent" />}
          <span className="font-medium">{row.domain}</span>
          {row.status === "loading" && (
            <span className="text-muted-foreground">
              <Spinner size={12} />
            </span>
          )}
          {row.status === "error" && (
            <span
              className="text-danger"
              title={row.error || "Failed to load"}
            >
              <AlertIcon size={13} />
            </span>
          )}
        </div>
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
        {formatNumber(row.mailboxes)}
      </td>
      {h ? (
        <>
          <td className="px-4 py-3 text-right tabular-nums">
            {formatNumber(h.total_sent_count)}
          </td>
          <td className="px-4 py-3 text-right tabular-nums">
            {formatNumber(uniqueContacted(h))}
          </td>
          <td className="px-4 py-3 text-right tabular-nums">
            {formatNumber(h.total_reply_count)}
          </td>
          <ReplyHeatCell rate={h.reply_rate} />
          <ReplyHeatCell rate={h.reply_rate_with_ooo} muted />
          <td className="px-4 py-3 text-right tabular-nums">
            {formatPercent(h.pos_reply_rate)}
          </td>
          <td
            className={`px-4 py-3 text-right tabular-nums ${healthText(
              bounceRateHealth(h.bounce_rate)
            )}`}
          >
            <span className="inline-flex items-center justify-end gap-1.5">
              <HealthDot health={bounceRateHealth(h.bounce_rate)} />
              {formatPercent(h.bounce_rate)}
            </span>
          </td>
        </>
      ) : (
        <td
          colSpan={7}
          className="px-4 py-3 text-right text-xs text-muted-foreground"
        >
          {row.status === "error" ? row.error || "Failed to load" : "Loading…"}
        </td>
      )}
    </tr>
  );
}

interface Totals {
  count: number;
  mailboxes: number;
  sent: number;
  contacted: number;
  replies: number;
  ooo: number;
  posReplies: number;
  bounces: number;
  replyRate: number;
  replyRateOoo: number;
  posRate: number;
  bounceRate: number;
}

export function computeTotals(rows: DomainRow[]): Totals {
  let mailboxes = 0;
  let sent = 0;
  let contacted = 0;
  let replies = 0;
  let ooo = 0;
  let posReplies = 0;
  let bounces = 0;
  let count = 0;

  for (const row of rows) {
    if (row.status !== "done" || !row.header) continue;
    const h = row.header;
    count++;
    mailboxes += row.mailboxes;
    sent += h.total_sent_count;
    contacted += uniqueContacted(h);
    replies += h.total_reply_count;
    ooo += h.total_ooo_reply_count;
    posReplies += h.total_pos_reply_count;
    bounces += h.total_bounce_count;
  }

  const replyRate = contacted > 0 ? (replies / contacted) * 100 : 0;
  const replyRateOoo = contacted > 0 ? ((replies + ooo) / contacted) * 100 : 0;
  const posRate = replies > 0 ? (posReplies / replies) * 100 : 0;
  const bounceRate = sent > 0 ? (bounces / sent) * 100 : 0;

  return {
    count,
    mailboxes,
    sent,
    contacted,
    replies,
    ooo,
    posReplies,
    bounces,
    replyRate,
    replyRateOoo,
    posRate,
    bounceRate,
  };
}
