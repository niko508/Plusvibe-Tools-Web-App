"use client";

import { useState } from "react";
import type { BlockedDomainJob } from "@/lib/jobs/blocked-domains-types";
import {
  byTld,
  byHost,
  byHostAndTld,
  byProvider,
  percent,
  UNKNOWN_HOST,
  UNKNOWN_TLD,
  UNKNOWN_PROVIDER,
  type Breakdown,
  type BreakdownRow,
} from "@/lib/blocked-domains/stats";
import { formatNumber } from "@/lib/format";
import { EmptyState } from "@/components/ui";
import { GaugeIcon } from "@/components/icons";

// Where the blocks come from: by the domain's ending, by the registrar it sits
// with, and by the two together. Every record in the log is one block, so the
// counts here are counts of blocked domains.

export function StatsView({ jobs }: { jobs: BlockedDomainJob[] }) {
  if (jobs.length === 0) {
    return (
      <EmptyState icon={<GaugeIcon />} title="Nothing to count yet">
        Once domains have come through from Clay, this breaks the blocks down
        by ending and by domain host, so it is clear which ones keep getting
        blocked.
      </EmptyState>
    );
  }

  const tld = byTld(jobs);
  const host = byHost(jobs);
  const pair = byHostAndTld(jobs);
  const provider = byProvider(jobs);
  const distinct = new Set(jobs.map((j) => j.domain)).size;
  const hostsKnown = jobs.filter((j) => j.sheet?.domainHost?.trim()).length;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Figure label="Blocks" value={formatNumber(jobs.length)} />
        <Figure label="Distinct domains" value={formatNumber(distinct)} />
        <Figure label="Endings" value={formatNumber(tld.rows.length)} />
        <Figure
          label="Hosts"
          value={formatNumber(host.rows.filter((r) => r.key !== UNKNOWN_HOST).length)}
          hint={
            hostsKnown < jobs.length
              ? `${formatNumber(jobs.length - hostsKnown)} block${jobs.length - hostsKnown === 1 ? "" : "s"} with no host in the sheet`
              : undefined
          }
        />
      </div>

      <BreakdownTable
        title="By ending"
        what="ending"
        breakdown={tld}
        intro="Which TLDs the blocked domains have. A share well above that ending's share of what you bought is the signal."
      />
      <BreakdownTable
        title="By domain host"
        what="host"
        breakdown={host}
        intro="The registrar each blocked domain sits with, from the Domain Host column of the Domains sheet."
      />
      <BreakdownTable
        title="By mailbox provider"
        what="provider"
        breakdown={provider}
        intro="Google Workspace, Microsoft 365 or other, from what Plusvibe reports for the domain's inboxes. A domain is counted under the provider most of its inboxes were on."
      />
      <BreakdownTable
        title="By host and ending"
        what="combination"
        breakdown={pair}
        intro="The two together — the exact combination that keeps producing blocks."
        collapsedAt={8}
      />
    </div>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="pv-card p-3">
      <div className="truncate text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

function BreakdownTable({
  title,
  what,
  breakdown,
  intro,
  collapsedAt,
}: {
  title: string;
  what: string;
  breakdown: Breakdown;
  intro: string;
  /** Show only the top N until asked for the rest. */
  collapsedAt?: number;
}) {
  const [showAll, setShowAll] = useState(false);
  const rows = collapsedAt && !showAll ? breakdown.rows.slice(0, collapsedAt) : breakdown.rows;
  const hidden = breakdown.rows.length - rows.length;
  const top = breakdown.rows[0];

  return (
    <section className="pv-card p-4 sm:p-5" aria-label={title}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="text-xs text-muted-foreground">
          {formatNumber(breakdown.rows.length)} {what}
          {breakdown.rows.length === 1 ? "" : "s"}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{intro}</p>
      {top && breakdown.rows.length > 1 && (
        <p className="mt-2 text-xs">
          <span className="font-medium">{top.key}</span> leads with{" "}
          {formatNumber(top.count)} of {formatNumber(breakdown.total)} blocks ({percent(top.share)}).
        </p>
      )}

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="pb-2 pr-3 font-medium capitalize">{what}</th>
              <th className="pb-2 pr-3 font-medium">Share of blocks</th>
              <th className="pb-2 pr-3 text-right font-medium">Blocks</th>
              <th className="pb-2 pr-3 text-right font-medium" title="Not Active in the sheet, tenant queued">
                Written off
              </th>
              <th className="pb-2 pr-3 text-right font-medium" title="Left sending: at or above the domain bar">
                Kept
              </th>
              <th className="pb-2 pr-3 text-right font-medium">Inboxes stopped</th>
              <th className="pb-2 text-right font-medium">Inboxes deleted</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Row key={r.key} row={r} />
            ))}
          </tbody>
        </table>
      </div>

      {hidden > 0 && (
        <button
          type="button"
          className="mt-2 text-xs text-muted-foreground underline"
          onClick={() => setShowAll(true)}
        >
          {formatNumber(hidden)} more
        </button>
      )}
    </section>
  );
}

function Row({ row }: { row: BreakdownRow }) {
  return (
    <tr className="border-t border-border">
      <td className="py-2 pr-3 font-medium">
        <span className={row.key.includes(UNKNOWN_HOST) || row.key.includes(UNKNOWN_TLD) || row.key === UNKNOWN_PROVIDER ? "text-muted-foreground" : ""}>
          {row.key}
        </span>
        {row.domains !== row.count && (
          <span className="ml-1.5 text-muted-foreground" title="Some domains were flagged more than once">
            ({formatNumber(row.domains)} domain{row.domains === 1 ? "" : "s"})
          </span>
        )}
      </td>
      <td className="py-2 pr-3">
        <div className="flex items-center gap-2">
          <div className="h-2 w-full min-w-[80px] max-w-[220px] overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-accent"
              style={{ width: `${Math.max(2, row.share * 100)}%` }}
            />
          </div>
          <span className="w-10 shrink-0 tabular-nums">{percent(row.share)}</span>
        </div>
      </td>
      <td className="py-2 pr-3 text-right tabular-nums">{formatNumber(row.count)}</td>
      <td className="py-2 pr-3 text-right tabular-nums">{formatNumber(row.writtenOff)}</td>
      <td className="py-2 pr-3 text-right tabular-nums text-success">{formatNumber(row.kept)}</td>
      <td className="py-2 pr-3 text-right tabular-nums">{formatNumber(row.inboxesStopped)}</td>
      <td className="py-2 text-right tabular-nums">{formatNumber(row.inboxesDeleted)}</td>
    </tr>
  );
}
