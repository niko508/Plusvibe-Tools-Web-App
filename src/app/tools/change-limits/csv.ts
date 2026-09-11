import { VERDICT_LABELS } from "@/lib/change-limits/qualify";
import { providerShort } from "../domain-performance/providers";
import type { InboxRow } from "./types";

// Builds a CSV of the judged inboxes and triggers a browser download. The
// reply rate is the app's own — replies over unique contacts — and the
// threshold each inbox was measured against travels with it, so the file
// explains its own verdicts.
export function exportJudgedCsv(
  rows: InboxRow[],
  meta: { scope: string; start: string; end: string }
) {
  const headers = [
    "inbox",
    "workspace",
    "provider",
    "sent",
    "unique_contacted",
    "replies",
    "true_reply_rate",
    "threshold",
    "verdict",
  ];
  const lines = [headers.join(",")];
  for (const row of rows) {
    const r = row.rates;
    lines.push(
      [
        row.email,
        row.workspaceName,
        providerShort(row.provider),
        r?.sent ?? "",
        r?.contacted ?? "",
        r?.replies ?? "",
        r?.replyRate ?? "",
        row.threshold ?? "",
        row.verdict ? VERDICT_LABELS[row.verdict] : "",
      ]
        .map(csvCell)
        .join(",")
    );
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const safe = meta.scope.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const a = document.createElement("a");
  a.href = url;
  a.download = `change-limits_${safe}_${meta.start}_${meta.end}.csv`;
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
