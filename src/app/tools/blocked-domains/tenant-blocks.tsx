"use client";

// Every domain blocked as a whole: Clay's Tenant Block column (or the button
// on Settings), and Microsoft domains cancelled after too many deletions.
// Each one: every inbox on it stopped and deleted, the domain Not Active, its
// tenant on 🚯 Tenants to Cancel.

import { Fragment, useMemo, useState } from "react";
import type { BlockedInboxJob, InboxDomainState } from "@/lib/jobs/blocked-inboxes-types";
import { formatNumber } from "@/lib/format";
import { EmptyState } from "@/components/ui";
import { ChevronDownIcon, TrashIcon } from "@/components/icons";
import { DomainDetail } from "./blocked-lists";
import { INBOX_STATUS, relativeTime } from "./inbox-card";

/** A domain blocked as a whole, or asked to be. */
export function isTenantBlock(d: InboxDomainState): boolean {
  return d.cancelRequestedAt !== undefined || d.cancelledAt !== undefined;
}

function why(d: InboxDomainState, cancelAfter: number): string {
  if (d.cancelReason === "tenant-block") return d.tenantBlockSource === "manual" ? "Blocked by hand" : "Clay: Tenant Block";
  return `More than ${cancelAfter} deleted`;
}

function state(d: InboxDomainState): { text: string; tone: string } {
  if (d.cancelling) return { text: "Blocking…", tone: "text-accent" };
  if (d.cancelledAt === undefined) return { text: "In line", tone: "text-accent" };
  if (d.errors.length > 0) return { text: "Done, with problems", tone: "text-warning" };
  return { text: "Done", tone: "text-danger" };
}

export function TenantBlocksView({
  states,
  jobs,
  cancelAfter,
}: {
  states: InboxDomainState[];
  jobs: BlockedInboxJob[];
  cancelAfter: number;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const blocks = useMemo(
    () =>
      states
        .filter(isTenantBlock)
        .sort((a, b) => (b.cancelledAt ?? b.cancelRequestedAt ?? 0) - (a.cancelledAt ?? a.cancelRequestedAt ?? 0)),
    [states]
  );
  // The inboxes each block stopped, by their records — hidden from Home or not.
  const byDomain = useMemo(() => {
    const m = new Map<string, BlockedInboxJob[]>();
    for (const j of jobs) {
      if (!j.cancelledWithDomain) continue;
      const list = m.get(j.domain) ?? [];
      list.push(j);
      m.set(j.domain, list);
    }
    return m;
  }, [jobs]);
  const q = filter.trim().toLowerCase();
  const rows = q ? blocks.filter((d) => d.domain.includes(q) || (d.tenantEmail ?? "").toLowerCase().includes(q)) : blocks;

  if (blocks.length === 0) {
    return (
      <EmptyState icon={<TrashIcon />} title="No tenant blocks yet">
        A domain lands here when Clay&apos;s Tenant Block column says YES for one of its inboxes, when it is blocked by hand on Settings, or
        when more than {cancelAfter} of its Microsoft inboxes have been deleted.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-3" data-tenant-blocks>
      <div className="flex flex-wrap items-center gap-3">
        <input
          className="pv-input max-w-xs"
          placeholder="Filter by domain or tenant…"
          value={filter}
          aria-label="Filter tenant blocks"
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="text-xs text-muted-foreground">
          {formatNumber(blocks.length)} domain{blocks.length === 1 ? "" : "s"} blocked as a whole: every inbox stopped and deleted, the
          domain Not Active in 📋 Domains, its tenant on 🚯 Tenants to Cancel.
        </span>
      </div>
      <div className="pv-card overflow-x-auto p-0">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="px-3 py-2 font-medium">Domain</th>
              <th className="px-3 py-2 font-medium">Why</th>
              <th className="px-3 py-2 font-medium">State</th>
              <th className="px-3 py-2 text-right font-medium">Inboxes stopped</th>
              <th className="px-3 py-2 text-right font-medium">Deleted</th>
              <th className="px-3 py-2 font-medium">📋 Domains</th>
              <th className="px-3 py-2 font-medium">Tenant</th>
              <th className="px-3 py-2 font-medium">When</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => {
              const inboxes = byDomain.get(d.domain) ?? [];
              const st = state(d);
              const isOpen = open === d.domain;
              return (
                <Fragment key={d.domain}>
                  <tr
                    className="cursor-pointer border-t border-border hover:bg-muted/40"
                    onClick={() => setOpen((o) => (o === d.domain ? null : d.domain))}
                    aria-expanded={isOpen}
                  >
                    <td className="px-3 py-2 font-mono" data-tenant-domain={d.domain}>
                      {d.domain}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">{why(d, cancelAfter)}</td>
                    <td className={`whitespace-nowrap px-3 py-2 ${st.tone}`} data-tenant-state={d.domain}>
                      {st.text}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatNumber(d.cancelledInboxes?.length ?? inboxes.length)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatNumber(inboxes.filter((j) => j.status === "deleted").length)}</td>
                    <td className="whitespace-nowrap px-3 py-2">{d.notActiveAt ? "Not Active" : d.cancelledAt ? "—" : ""}</td>
                    <td className="px-3 py-2" data-tenant-queue={d.domain}>
                      {d.tenantEmail ? (
                        <span>
                          <span className="font-mono">{d.tenantEmail}</span>
                          <span className="text-muted-foreground">{d.tenantQueued ? " · queued" : d.tenantAlreadyQueued ? " · already queued" : " · not queued"}</span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground">{d.cancelledAt ? "none in the sheet" : ""}</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{relativeTime(d.cancelledAt ?? d.cancelRequestedAt ?? d.updatedAt)}</td>
                    <td className="px-2 py-2 text-muted-foreground">
                      <ChevronDownIcon size={14} className={`transition-transform ${isOpen ? "rotate-180" : ""}`} />
                    </td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={9} className="bg-muted/20 px-3 py-3">
                        <div className="space-y-2 text-xs">
                          <DomainDetail state={d} />
                          {(d.tenantBlockHits ?? 0) > 0 && (
                            <p className="text-muted-foreground">
                              Clay sent it {formatNumber(d.tenantBlockHits ?? 0)} more time{d.tenantBlockHits === 1 ? "" : "s"} since.
                            </p>
                          )}
                          {inboxes.length > 0 ? (
                            <ul className="space-y-1">
                              {inboxes.map((i) => (
                                <li key={i.id} className="flex flex-wrap gap-x-3">
                                  <span className="font-mono">{i.email}</span>
                                  <span className="text-muted-foreground">
                                    {(INBOX_STATUS[i.status] ?? INBOX_STATUS.error).label}
                                    {i.workspaceName ? ` · ${i.workspaceName}` : ""}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            d.cancelledAt !== undefined && <p className="text-muted-foreground">No inboxes were left on it to stop.</p>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
