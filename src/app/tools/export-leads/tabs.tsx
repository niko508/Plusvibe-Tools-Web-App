"use client";

// Export and Remove side by side. Both stay mounted, so switching tabs never
// cuts off a download or a delete that's running.

import { useState } from "react";
import { ExportLeadsTool } from "./tool";
import { RemoveLeadsTool } from "./remove-leads";

const TABS = [
  { key: "export", label: "Export CSV" },
  { key: "remove", label: "Remove leads" },
] as const;
type Tab = (typeof TABS)[number]["key"];

export function ExportRemoveTabs() {
  const [tab, setTab] = useState<Tab>("export");
  return (
    <div className="space-y-5">
      <div role="tablist" aria-label="Export or remove" className="inline-flex rounded-xl border border-border p-1">
        {TABS.map((t) => {
          const active = t.key === tab;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.key)}
              data-tab={t.key}
              className={`rounded-lg px-3 py-1.5 text-sm transition ${active ? "bg-accent/10 font-medium text-accent" : "text-muted-foreground hover:text-foreground"}`}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      <div hidden={tab !== "export"} data-panel="export">
        <ExportLeadsTool />
      </div>
      <div hidden={tab !== "remove"} data-panel="remove">
        <RemoveLeadsTool />
      </div>
    </div>
  );
}
