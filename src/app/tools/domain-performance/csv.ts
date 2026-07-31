import type { DomainRow } from "./types";
import { uniqueContacted } from "@/lib/format";

// Builds a CSV of the per-domain table and triggers a browser download.
export function exportDomainsCsv(
  rows: DomainRow[],
  meta: { workspace: string; start: string; end: string }
) {
  const headers = [
    "domain",
    "mailboxes",
    "sent",
    "unique_contacted",
    "replies",
    "ooo_replies",
    "positive_replies",
    "bounces",
    "reply_rate",
    "reply_rate_with_ooo",
    "positive_reply_rate",
    "bounce_rate",
  ];

  const lines = [headers.join(",")];

  for (const row of rows) {
    const h = row.header;
    const cells = [
      row.domain,
      row.mailboxes,
      h?.total_sent_count ?? "",
      h ? uniqueContacted(h) : "",
      h?.total_reply_count ?? "",
      h?.total_ooo_reply_count ?? "",
      h?.total_pos_reply_count ?? "",
      h?.total_bounce_count ?? "",
      h?.reply_rate ?? "",
      h?.reply_rate_with_ooo ?? "",
      h?.pos_reply_rate ?? "",
      h?.bounce_rate ?? "",
    ];
    lines.push(cells.map(csvCell).join(","));
  }

  const blob = new Blob([lines.join("\n")], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const safeWs = meta.workspace.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const a = document.createElement("a");
  a.href = url;
  a.download = `domain-performance_${safeWs}_${meta.start}_${meta.end}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function csvCell(value: string | number): string {
  const s = String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
