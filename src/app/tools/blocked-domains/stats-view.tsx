"use client";

import { useMemo, useState } from "react";
import type { BlockedDomainJob } from "@/lib/jobs/blocked-domains-types";
import type { BlockedInboxJob } from "@/lib/jobs/blocked-inboxes-types";
import {
  byPlatform,
  byPlatformAndTld,
  byProvider,
  byTld,
  percent,
  statsEntries,
  UNKNOWN_PLATFORM,
  UNKNOWN_PROVIDER,
  UNKNOWN_TLD,
  type StatBreakdown,
  type StatRow,
} from "@/lib/blocked-inboxes/domains";
import { formatNumber } from "@/lib/format";
import { EmptyState } from "@/components/ui";
import { GaugeIcon } from "@/components/icons";

// Where the blocks come from: by the domain's ending, by the platform it was
// bought on, by mailbox provider, and by platform and ending together. A
// domain counts once, as soon as any inbox on it is blocked; the domain-level
// runs from before the move to inboxes count too.

export function StatsView({ inboxJobs, domainJobs }: { inboxJobs: BlockedInboxJob[]; domainJobs: BlockedDomainJob[] }) {
  const entries = useMemo(() => statsEntries(inboxJobs, domainJobs), [inboxJobs, domainJobs]);
  if (entries.length === 0) {
    return (
      <EmptyState icon={<GaugeIcon />} title="Nothing to count yet">
        Once inboxes have been blocked, this breaks the blocked domains down by ending and by platform, so it is clear
        which ones keep getting blocked.
      </EmptyState>
    );
  }

  const tld = byTld(entries);
  const platform = byPlatform(entries);
  const pair = byPlatformAndTld(entries);
  const provider = byProvider(entries);
  const inboxes = entries.reduce((n, e) => n + e.blockedInboxes, 0);
  const fromOld = entries.filter((e) => e.fromDomainRun).length;
  const platformsKnown = entries.filter((e) => e.platform !== UNKNOWN_PLATFORM).length;

  return (
    <div className="space-y-5" data-stats>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Figure
          label="Blocked domains"
          value={formatNumber(entries.length)}
          hint={fromOld > 0 ? `${formatNumber(fromOld)} from the old domain-level runs` : undefined}
        />
        <Figure label="Blocked inboxes" value={formatNumber(inboxes)} />
        <Figure label="Endings" value={formatNumber(tld.rows.length)} />
        <Figure
          label="Platforms"
          value={formatNumber(platform.rows.filter((r) => r.key !== UNKNOWN_PLATFORM).length)}
          hint={platformsKnown < entries.length ? `${formatNumber(entries.length - platformsKnown)} with no platform known` : undefined}
        />
      </div>

      <BreakdownTable title="By ending" what="ending" breakdown={tld} intro="Which TLDs the blocked domains have. A share well above that ending's share of what you bought is the signal." />
      <BreakdownTable
        title="By platform"
        what="platform"
        breakdown={platform}
        intro="Where each blocked domain was bought: the Domain Host column of the Domains sheet, or the registrar on the domain's public record when the sheet has none."
      />
      <BreakdownTable title="By mailbox provider" what="provider" breakdown={provider} intro="Google or Microsoft, from what Plusvibe reports for the blocked inboxes." />
      <BreakdownTable
        title="By platform and ending"
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
  breakdown: StatBreakdown;
  intro: string;
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
          <span className="font-medium">{top.key}</span> leads with {formatNumber(top.domains)} of {formatNumber(breakdown.total)} blocked
          domains ({percent(top.share)}).
        </p>
      )}
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="pb-2 pr-3 font-medium capitalize">{what}</th>
              <th className="pb-2 pr-3 font-medium">Share of blocked domains</th>
              <th className="pb-2 pr-3 text-right font-medium">Blocked domains</th>
              <th className="pb-2 pr-3 text-right font-medium">Blocked inboxes</th>
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
        <button type="button" className="mt-2 text-xs text-muted-foreground underline" onClick={() => setShowAll(true)}>
          {formatNumber(hidden)} more
        </button>
      )}
    </section>
  );
}

function Row({ row }: { row: StatRow }) {
  const unknown = row.key.includes(UNKNOWN_PLATFORM) || row.key.includes(UNKNOWN_TLD) || row.key === UNKNOWN_PROVIDER;
  return (
    <tr className="border-t border-border">
      <td className={`py-2 pr-3 font-medium ${unknown ? "text-muted-foreground" : ""}`}>{row.key}</td>
      <td className="py-2 pr-3">
        <div className="flex items-center gap-2">
          <div className="h-2 w-full min-w-[80px] max-w-[220px] overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(2, row.share * 100)}%` }} />
          </div>
          <span className="w-10 shrink-0 tabular-nums">{percent(row.share)}</span>
        </div>
      </td>
      <td className="py-2 pr-3 text-right tabular-nums">{formatNumber(row.domains)}</td>
      <td className="py-2 pr-3 text-right tabular-nums">{formatNumber(row.blockedInboxes)}</td>
      <td className="py-2 text-right tabular-nums">{formatNumber(row.deletedInboxes)}</td>
    </tr>
  );
}
