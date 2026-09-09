import type { InboxRow } from "./types";
import { providerShort } from "../domain-performance/providers";

// Builds a CSV of the per-inbox table and triggers a browser download. Rates
// are the app's own — over unique contacts — not Plusvibe's per-sent ones.
export function exportInboxesCsv(rows: InboxRow[], meta: { scope: string; start: string; end: string }) {
  const headers = [
    "inbox",
    "domain",
    "workspace",
    "provider",
    "account_status",
    "warmup_status",
    "sent",
    "unique_contacted",
    "replies",
    "ooo_replies",
    "positive_replies",
    "bounces",
    "true_reply_rate",
    "reply_rate_with_ooo",
    "positive_reply_rate",
    "bounce_rate",
  ];
  const lines = [headers.join(",")];
  for (const row of rows) {
    const r = row.rates;
    const cells = [
      row.email,
      row.domain,
      row.workspaceName,
      providerShort(row.provider),
      row.accountStatus ?? "",
      row.warmupStatus ?? "",
      r?.sent ?? "",
      r?.contacted ?? "",
      r?.replies ?? "",
      r?.ooo ?? "",
      r?.posReplies ?? "",
      r?.bounces ?? "",
      r?.replyRate ?? "",
      r?.replyRateOoo ?? "",
      r?.posRate ?? "",
      r?.bounceRate ?? "",
    ];
    lines.push(cells.map(csvCell).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const safe = meta.scope.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const a = document.createElement("a");
  a.href = url;
  a.download = `inbox-performance_${safe}_${meta.start}_${meta.end}.csv`;
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
