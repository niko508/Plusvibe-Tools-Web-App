"use client";

// The two lists the automation keeps: every inbox it blocked, and every domain
// one of those inboxes was on.

import { useMemo, useState, type ReactNode } from "react";
import { isBlocked, type BlockedInboxJob } from "@/lib/jobs/blocked-inboxes-types";
import { blockedDomains, platformKey, UNKNOWN_PLATFORM } from "@/lib/blocked-inboxes/domains";
import { PROVIDER_LABELS } from "@/lib/plusvibe-providers";
import { formatNumber } from "@/lib/format";
import { EmptyState, Spinner } from "@/components/ui";
import { ChevronDownIcon, TrashIcon } from "@/components/icons";
import { INBOX_STATUS, InboxCard, relativeTime } from "./inbox-card";

const PAGE = 50;

export function BlockedInboxesView({
  jobs,
  busyId,
  onConfirm,
  onDismiss,
  onRemove,
  onConfirmAll,
  confirmingAll,
}: {
  jobs: BlockedInboxJob[];
  busyId: string | null;
  onConfirm: (id: string) => void;
  onDismiss: (id: string) => void;
  onRemove: (id: string) => void;
  onConfirmAll: () => void;
  confirmingAll: boolean;
}) {
  const [filter, setFilter] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [open, setOpen] = useState<string | null>(null);
  const blocked = useMemo(
    () => jobs.filter(isBlocked).sort((a, b) => (b.blockedAt ?? b.createdAt) - (a.blockedAt ?? a.createdAt)),
    [jobs]
  );
  const q = filter.trim().toLowerCase();
  const rows = q ? blocked.filter((j) => j.email.includes(q) || (j.workspaceName ?? "").toLowerCase().includes(q)) : blocked;
  const waiting = blocked.filter((j) => j.status === "awaiting_confirmation").length;

  if (blocked.length === 0) {
    return (
      <EmptyState icon={<TrashIcon />} title="No blocked inboxes yet">
        Every inbox Clay sends that fails its rule lands here.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-3" data-blocked-inboxes>
      <div className="flex flex-wrap items-center gap-3">
        <input
          className="pv-input max-w-xs"
          placeholder="Filter by inbox or workspace…"
          value={filter}
          aria-label="Filter blocked inboxes"
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="text-xs text-muted-foreground">
          {formatNumber(blocked.length)} blocked · {formatNumber(blocked.filter((j) => j.status === "deleted").length)} deleted
          {waiting > 0 ? ` · ${formatNumber(waiting)} waiting for you` : ""}
        </span>
        {waiting > 0 && (
          <button type="button" className="pv-btn-ghost text-danger disabled:opacity-50" data-confirm-all disabled={confirmingAll} onClick={onConfirmAll}>
            {confirmingAll ? <Spinner size={14} /> : <TrashIcon size={14} />} Delete all {formatNumber(waiting)} waiting
          </button>
        )}
      </div>

      <div className="pv-card overflow-x-auto p-0">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="px-3 py-2 font-medium">Inbox</th>
              <th className="px-3 py-2 font-medium">Provider</th>
              <th className="px-3 py-2 font-medium">Platform</th>
              <th className="px-3 py-2 text-right font-medium">Sent</th>
              <th className="px-3 py-2 text-right font-medium">Bounce</th>
              <th className="px-3 py-2 text-right font-medium">OOO reply</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Blocked</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, shown).map((j) => {
              const st = INBOX_STATUS[j.status] ?? INBOX_STATUS.error;
              const platform = platformKey(j.domainHost, j.registrar);
              return (
                <FragmentRow
                  key={j.id}
                  open={open === j.id}
                  onToggle={() => setOpen((o) => (o === j.id ? null : j.id))}
                  cells={
                    <>
                      <td className="px-3 py-2 font-mono">{j.email}</td>
                      <td className="px-3 py-2">{j.provider ? PROVIDER_LABELS[j.provider] : "—"}</td>
                      <td className="px-3 py-2">{platform === UNKNOWN_PLATFORM ? "—" : platform}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{j.figures ? formatNumber(j.figures.sent) : "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{j.rates ? `${j.rates.bounceRate}%` : "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{j.rates ? `${j.rates.oooReplyRate}%` : "—"}</td>
                      <td className="px-3 py-2">
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${st.className}`}>{st.label.replace(/^Blocked — /, "")}</span>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{relativeTime(j.blockedAt ?? j.createdAt)}</td>
                    </>
                  }
                  detail={
                    <InboxCard
                      job={j}
                      busy={busyId === j.id}
                      onConfirm={onConfirm}
                      onDismiss={onDismiss}
                      onRemove={onRemove}
                    />
                  }
                />
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length > shown && (
        <button type="button" className="text-xs text-muted-foreground underline" onClick={() => setShown((n) => n + PAGE)}>
          Show {formatNumber(Math.min(PAGE, rows.length - shown))} more of {formatNumber(rows.length - shown)}
        </button>
      )}
    </div>
  );
}

export function BlockedDomainsList({ jobs }: { jobs: BlockedInboxJob[] }) {
  const domains = useMemo(() => blockedDomains(jobs), [jobs]);
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [shown, setShown] = useState(PAGE);
  const q = filter.trim().toLowerCase();
  const rows = q ? domains.filter((d) => d.domain.includes(q) || (d.workspaceName ?? "").toLowerCase().includes(q)) : domains;

  if (domains.length === 0) {
    return (
      <EmptyState icon={<TrashIcon />} title="No blocked domains yet">
        A domain lands here as soon as one of its inboxes is blocked.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-3" data-blocked-domains>
      <div className="flex flex-wrap items-center gap-3">
        <input
          className="pv-input max-w-xs"
          placeholder="Filter by domain or workspace…"
          value={filter}
          aria-label="Filter blocked domains"
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="text-xs text-muted-foreground">
          {formatNumber(domains.length)} domain{domains.length === 1 ? "" : "s"} with a blocked inbox. Nothing is done to a domain as a whole — this is where its blocked inboxes add up.
        </span>
      </div>
      <div className="pv-card overflow-x-auto p-0">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="px-3 py-2 font-medium">Domain</th>
              <th className="px-3 py-2 font-medium">Ending</th>
              <th className="px-3 py-2 font-medium">Platform</th>
              <th className="px-3 py-2 font-medium">Provider</th>
              <th className="px-3 py-2 font-medium">Workspace</th>
              <th className="px-3 py-2 text-right font-medium">Blocked inboxes</th>
              <th className="px-3 py-2 text-right font-medium">Deleted</th>
              <th className="px-3 py-2 font-medium">Last blocked</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, shown).map((d) => (
              <FragmentRow
                key={d.domain}
                open={open === d.domain}
                onToggle={() => setOpen((o) => (o === d.domain ? null : d.domain))}
                cells={
                  <>
                    <td className="px-3 py-2 font-mono" data-domain={d.domain}>{d.domain}</td>
                    <td className="px-3 py-2">{d.tld}</td>
                    <td className="px-3 py-2">{d.platform === UNKNOWN_PLATFORM ? "—" : d.platform}</td>
                    <td className="px-3 py-2">{d.provider}</td>
                    <td className="px-3 py-2">{d.workspaceName ?? "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatNumber(d.blockedInboxes)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatNumber(d.deletedInboxes)}</td>
                    <td className="px-3 py-2 text-muted-foreground">{relativeTime(d.lastBlockedAt)}</td>
                  </>
                }
                detail={
                  <ul className="space-y-1 px-1 py-1 text-xs">
                    {d.inboxes.map((i) => (
                      <li key={i.jobId} className="flex flex-wrap gap-x-3">
                        <span className="font-mono">{i.email}</span>
                        <span className="text-muted-foreground">
                          {(INBOX_STATUS[i.status] ?? INBOX_STATUS.error).label} · {relativeTime(i.blockedAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                }
              />
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > shown && (
        <button type="button" className="text-xs text-muted-foreground underline" onClick={() => setShown((n) => n + PAGE)}>
          Show {formatNumber(Math.min(PAGE, rows.length - shown))} more of {formatNumber(rows.length - shown)}
        </button>
      )}
    </div>
  );
}

/** A table row that opens to show more underneath it. */
function FragmentRow({ cells, detail, open, onToggle }: { cells: ReactNode; detail: ReactNode; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className="cursor-pointer border-t border-border hover:bg-muted/40" onClick={onToggle} aria-expanded={open}>
        {cells}
        <td className="px-2 py-2 text-muted-foreground">
          <ChevronDownIcon size={14} className={`transition-transform ${open ? "rotate-180" : ""}`} />
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={9} className="bg-muted/20 px-3 py-3">
            {detail}
          </td>
        </tr>
      )}
    </>
  );
}
