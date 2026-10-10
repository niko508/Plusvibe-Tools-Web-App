"use client";

// Every domain blocked as a whole: Clay's Tenant Block column (or the button
// on Settings), and Microsoft domains cancelled after too many deletions.
// Each one: every inbox on it stopped and deleted, the domain Not Active, its
// tenant on 🚯 Tenants to Cancel.

import { Fragment, useMemo, useState } from "react";
import { NO_GOOGLE_TAG, type BlockedInboxJob, type InboxDomainState } from "@/lib/jobs/blocked-inboxes-types";
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
  if (d.cancelReason === "tenant-block") return d.tenantBlockSource === "manual" ? "Blocked by hand" : `Clay: ${(d.blockColumn === "domain-blocked" ? "Domain Blocked" : "Tenant Block")}`;
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
      <>
      <GoogleStops states={states} />
      <EmptyState icon={<TrashIcon />} title="No tenant blocks yet">
        A domain lands here when Clay&apos;s Domain Blocked or Tenant Block column says YES for one of its inboxes, when it is blocked by hand on Settings, or
        when more than {cancelAfter} of its Microsoft inboxes have been deleted.
      </EmptyState>
      </>
    );
  }

  return (
    <div className="space-y-3" data-tenant-blocks>
      <GoogleStops states={states} />
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

/** A domain taken out as a whole, as a compact card for Home. */
export function DomainEventCard({
  d,
  inboxes = [],
  busy,
  onRemove,
  onDeleteAll,
  onKeepAll,
}: {
  d: InboxDomainState;
  /** The inboxes the domain block stopped, by their records. */
  inboxes?: BlockedInboxJob[];
  busy: boolean;
  onRemove: (domain: string) => void;
  onDeleteAll?: (domain: string) => void;
  onKeepAll?: (domain: string) => void;
}) {
  const waiting = inboxes.filter((j) => j.status === "awaiting_confirmation").length;
  const deleting = inboxes.filter((j) => j.status === "deleting").length;
  const deleted = inboxes.filter((j) => j.status === "deleted").length;
  const kept = inboxes.filter((j) => j.status === "dismissed").length;
  const failed = inboxes.filter((j) => j.status === "error").length;
  const tenantBlock = d.cancelReason === "tenant-block";
  const inProgress = d.cancelledAt === undefined && d.cancelRequestedAt !== undefined;
  const label = inProgress
    ? { text: d.cancelling ? "Blocking domain…" : "Domain block in line", className: "bg-accent/10 text-accent" }
    : d.cancelledAt !== undefined
      ? { text: tenantBlock ? "Tenant blocked" : "Domain cancelled", className: "bg-danger/10 text-danger" }
      : { text: "Not Active · last inbox", className: "bg-danger/10 text-danger" };
  const stopped = d.cancelledInboxes?.length ?? 0;
  return (
    <div className="pv-card p-4 sm:p-5" data-domain-event={d.domain}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${label.className}`}>{label.text}</span>
          <span className="truncate font-mono text-sm font-medium">{d.domain}</span>
          {d.workspaceName && <span className="pv-chip shrink-0">{d.workspaceName}</span>}
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(d.cancelledAt ?? d.notActiveAt ?? d.cancelRequestedAt ?? d.updatedAt)}</span>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {d.cancelledAt !== undefined
          ? `${tenantBlock ? (d.tenantBlockSource === "manual" ? "Blocked by hand" : `Clay's ${(d.blockColumn === "domain-blocked" ? "Domain Blocked" : "Tenant Block")} said YES`) : "More than the allowed inboxes deleted"}: ${formatNumber(stopped)} inbox${stopped === 1 ? "" : "es"} stopped${d.notActiveAt ? ", set Not Active" : ""}${d.tenantQueued || d.tenantAlreadyQueued ? `, tenant ${d.tenantEmail} on 🚯 Tenants to Cancel` : ""}.`
          : inProgress
            ? "Every inbox on it will be stopped, the domain set Not Active and its tenant queued to cancel."
            : `Its last Google inbox${d.lastInboxEmail ? `, ${d.lastInboxEmail},` : ""} was blocked, so it was set Not Active in 📋 Domains.`}
        {d.errors.length > 0 && <span className="text-warning"> {formatNumber(d.errors.length)} problem{d.errors.length === 1 ? "" : "s"} — see Tenant Blocks.</span>}
      </p>
      {inboxes.length > 0 && (
        <p className="mt-1 text-xs" data-domain-inboxes={d.domain}>
          {waiting > 0 && <span className="text-warning">{formatNumber(waiting)} waiting for you to delete. </span>}
          {deleting > 0 && <span className="text-accent">Deleting {formatNumber(deleting)}… </span>}
          {deleted > 0 && <span className="text-muted-foreground">{formatNumber(deleted)} deleted. </span>}
          {kept > 0 && <span className="text-muted-foreground">{formatNumber(kept)} kept stopped. </span>}
          {failed > 0 && <span className="text-danger">{formatNumber(failed)} couldn&apos;t be deleted — see Blocked Inboxes. </span>}
        </p>
      )}
      {!inProgress && waiting > 0 && (onDeleteAll || onKeepAll) && (
        <div className="mt-3 flex flex-wrap gap-2">
          {onDeleteAll && (
            <button type="button" className="pv-btn-ghost text-danger disabled:opacity-50" data-delete-domain-inboxes disabled={busy} onClick={() => onDeleteAll(d.domain)}>
              <TrashIcon size={14} /> Delete {formatNumber(waiting)} inbox{waiting === 1 ? "" : "es"}
            </button>
          )}
          {onKeepAll && (
            <button type="button" className="pv-btn-ghost disabled:opacity-50" data-keep-domain-inboxes disabled={busy} onClick={() => onKeepAll(d.domain)}>
              Keep them stopped
            </button>
          )}
        </div>
      )}
      {!inProgress && waiting === 0 && deleting === 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="pv-btn-ghost disabled:opacity-50"
            data-remove-domain
            disabled={busy}
            onClick={() => onRemove(d.domain)}
            title="Take it off Home. It stays on Blocked Domains and Tenant Blocks."
          >
            Remove
          </button>
        </div>
      )}
    </div>
  );
}

/** Domains Clay's Stop Sending to Google column tagged: their inboxes carry No Sending to Google. */
function GoogleStops({ states }: { states: InboxDomainState[] }) {
  const list = states.filter((d) => d.googleStop).sort((a, b) => (b.googleStop!.requestedAt ?? 0) - (a.googleStop!.requestedAt ?? 0));
  if (list.length === 0) return null;
  return (
    <section className="pv-card p-4 sm:p-5" data-google-stops>
      <h3 className="text-sm font-semibold">Stop Sending to Google</h3>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Every inbox on these domains is tagged <span className="font-medium">{NO_GOOGLE_TAG}</span>. Nothing else is done to them.
      </p>
      <ul className="mt-2 space-y-1 text-xs">
        {list.map((d) => {
          const g = d.googleStop!;
          const total = g.tagged + g.alreadyTagged;
          return (
            <li key={d.domain} className="flex flex-wrap items-baseline justify-between gap-x-3" data-google-stop={d.domain}>
              <span className="font-mono">{d.domain}</span>
              <span className={g.errors.length > 0 ? "text-warning" : "text-muted-foreground"}>
                {g.running || g.doneAt === undefined
                  ? "tagging…"
                  : `${formatNumber(total)} inbox${total === 1 ? "" : "es"} tagged${g.alreadyTagged ? ` (${formatNumber(g.alreadyTagged)} already were)` : ""}${
                      g.workspaces.length ? ` in ${g.workspaces.map((w) => w.workspaceName || w.workspaceId).join(", ")}` : ""
                    } · ${relativeTime(g.doneAt)}`}
                {g.hits > 0 ? ` · Clay sent it ${formatNumber(g.hits)} more time${g.hits === 1 ? "" : "s"}` : ""}
                {g.errors.length > 0 ? ` · ${g.errors.join(" ")}` : ""}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
