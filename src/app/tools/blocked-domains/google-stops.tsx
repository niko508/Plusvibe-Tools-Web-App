"use client";

// Stop Sending to Google: every domain Clay's column flagged, with every inbox
// on it tagged No Sending to Google. Nothing else is done to them — they keep
// sending to everyone but Google. Counted in Stats with the blocked domains.

import { useMemo, useState } from "react";
import { NO_GOOGLE_TAG, type InboxDomainState } from "@/lib/jobs/blocked-inboxes-types";
import { platformKey } from "@/lib/blocked-inboxes/domains";
import { formatNumber } from "@/lib/format";
import { EmptyState, Spinner } from "@/components/ui";
import { RefreshIcon } from "@/components/icons";
import { relativeTime } from "./inbox-card";

export function isGoogleStop(d: InboxDomainState): boolean {
  return d.googleStop !== undefined;
}

function state(d: InboxDomainState): { text: string; tone: string } {
  const g = d.googleStop!;
  if (g.running) return { text: "Tagging…", tone: "text-accent" };
  if (g.doneAt === undefined) return { text: "In line", tone: "text-accent" };
  if (g.errors.length > 0) return { text: "Done, with problems", tone: "text-warning" };
  return { text: "Tagged", tone: "text-success" };
}

export function GoogleStopsView({
  states,
  busy,
  onTagAgain,
}: {
  states: InboxDomainState[];
  busy: string | null;
  onTagAgain: (domain: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const [domain, setDomain] = useState("");
  const list = useMemo(
    () => states.filter(isGoogleStop).sort((a, b) => (b.googleStop!.requestedAt ?? 0) - (a.googleStop!.requestedAt ?? 0)),
    [states]
  );
  const q = filter.trim().toLowerCase();
  const rows = q ? list.filter((d) => d.domain.includes(q)) : list;
  const tagged = list.reduce((n, d) => n + d.googleStop!.tagged + d.googleStop!.alreadyTagged, 0);

  const addForm = (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!domain.trim()) return;
        onTagAgain(domain.trim());
        setDomain("");
      }}
    >
      <input className="pv-input max-w-xs" placeholder="domain.com" value={domain} aria-label="Domain to tag" onChange={(e) => setDomain(e.target.value)} />
      <button type="submit" className="pv-btn-ghost disabled:opacity-50" disabled={!domain.trim() || busy !== null} data-google-stop-add>
        Tag by hand
      </button>
    </form>
  );

  if (list.length === 0) {
    return (
      <div className="space-y-3">
        <EmptyState icon={<RefreshIcon />} title="No Stop Sending to Google yet">
          A domain lands here when Clay&apos;s Stop Sending to Google column says YES for one of its inboxes: every inbox on it, in every
          workspace, gets the {NO_GOOGLE_TAG} tag, and the google-pool tag comes off those that carry it. Nothing is stopped or deleted.
        </EmptyState>
        {addForm}
      </div>
    );
  }

  return (
    <div className="space-y-3" data-google-stops>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <input className="pv-input max-w-xs" placeholder="Filter by domain…" value={filter} aria-label="Filter Stop Sending to Google" onChange={(e) => setFilter(e.target.value)} />
          <span className="text-xs text-muted-foreground">
            {formatNumber(list.length)} domain{list.length === 1 ? "" : "s"} · {formatNumber(tagged)} inbox{tagged === 1 ? "" : "es"} tagged{" "}
            <span className="font-medium">{NO_GOOGLE_TAG}</span>, google-pool taken off. Nothing else is done to them.
          </span>
        </div>
        {addForm}
      </div>
      <div className="pv-card overflow-x-auto p-0">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="px-3 py-2 font-medium">Domain</th>
              <th className="px-3 py-2 font-medium">State</th>
              <th className="px-3 py-2 text-right font-medium">Inboxes tagged</th>
              <th className="px-3 py-2 font-medium">Workspaces</th>
              <th className="px-3 py-2 font-medium">Platform</th>
              <th className="px-3 py-2 text-right font-medium">Clay hits</th>
              <th className="px-3 py-2 font-medium">When</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => {
              const g = d.googleStop!;
              const st = state(d);
              const total = g.tagged + g.alreadyTagged;
              return (
                <tr key={d.domain} className="border-t border-border align-top" data-google-stop={d.domain}>
                  <td className="px-3 py-2 font-mono">{d.domain}</td>
                  <td className={`whitespace-nowrap px-3 py-2 ${st.tone}`}>
                    {st.text}
                    {g.errors.length > 0 && <span className="mt-0.5 block max-w-xs whitespace-normal text-[11px] text-warning">{g.errors.join(" ")}</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {g.doneAt === undefined ? "—" : formatNumber(total)}
                    {g.alreadyTagged > 0 && <span className="block text-[11px] text-muted-foreground">{formatNumber(g.alreadyTagged)} already were</span>}
                    {(g.poolRemoved ?? 0) > 0 && <span className="block text-[11px] text-muted-foreground">google-pool taken off {formatNumber(g.poolRemoved ?? 0)}</span>}
                  </td>
                  <td className="px-3 py-2">{g.workspaces.map((w) => `${w.workspaceName || w.workspaceId} (${formatNumber(w.inboxes)})`).join(", ") || "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2">{g.domainHost || g.registrar ? platformKey(g.domainHost, g.registrar) : "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatNumber(g.hits)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{relativeTime(g.doneAt ?? g.requestedAt)}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      className="pv-btn-ghost py-1 text-xs disabled:opacity-50"
                      disabled={busy !== null || g.running || (g.doneAt === undefined && !g.errors.length)}
                      onClick={() => onTagAgain(d.domain)}
                      title="Tag every inbox on it again — for inboxes added since"
                      data-google-stop-again={d.domain}
                    >
                      {busy === d.domain ? <Spinner size={12} /> : null} Tag again
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
