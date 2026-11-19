import type { JobError, JobMode } from "@/lib/jobs/types";

// Triggers a browser download of the given text as a file.
function download(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function exportNotFound(entries: string[], mode: JobMode = "domain") {
  download(
    mode === "inbox" ? "not-found-inboxes.txt" : "not-found-domains.txt",
    entries.join("\n"),
    "text/plain;charset=utf-8;"
  );
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function exportErrors(errors: JobError[]) {
  const lines = ["workspace,email,reason"];
  for (const e of errors) {
    lines.push(
      [e.workspaceName ?? e.workspace_id, e.email, e.reason].map(csvCell).join(",")
    );
  }
  download("delete-errors.csv", lines.join("\n"), "text/csv;charset=utf-8;");
}
