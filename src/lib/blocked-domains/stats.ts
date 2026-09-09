// Where the blockings come from.
//
// Every record in the log is one blocked domain. Grouping them by the domain's
// ending and by the registrar it sits with says which endings and which hosts
// keep producing blocks — the question that decides what to buy next time.
//
// Pure module — no clock, no API — so all of it is unit-tested.

import { tldOf } from "@/lib/tags/domain-tags";
import type { BlockedDomainJob } from "@/lib/jobs/blocked-domains-types";
import { dominantProvider, PROVIDER_LABELS } from "@/lib/plusvibe-providers";

export const UNKNOWN_HOST = "Unknown host";
export const UNKNOWN_TLD = "(no ending)";
export const UNKNOWN_PROVIDER = "Unknown mailbox";
export const MIXED_PROVIDER = "Mixed";

export interface BreakdownRow {
  key: string;
  /** Blocked domains in this group. */
  count: number;
  /** Of all blocked domains, as a fraction 0–1. */
  share: number;
  /** Written off: Not Active in the sheet, tenant queued. */
  writtenOff: number;
  /** Still replying well enough to keep. */
  kept: number;
  inboxesStopped: number;
  inboxesDeleted: number;
  /** Distinct domains — a re-armed domain flagged twice is one domain, two blocks. */
  domains: number;
}

export interface Breakdown {
  total: number;
  rows: BreakdownRow[];
}

/** A domain's ending, or a placeholder when it has none. */
export function tldKeyOf(domain: string): string {
  return tldOf(domain) ?? UNKNOWN_TLD;
}

/** The host as the sheet spelled it, trimmed, or a placeholder. */
export function hostKeyOf(job: BlockedDomainJob): string {
  const h = job.sheet?.domainHost?.trim();
  return h ? h : UNKNOWN_HOST;
}

/**
 * The mailbox provider a domain was running on: the one most of its inboxes
 * were with, "Mixed" for a genuine tie, or a placeholder for records from
 * before this was captured.
 */
export function providerKeyOf(job: BlockedDomainJob): string {
  if (!job.providers) return UNKNOWN_PROVIDER;
  const total = job.providers.google + job.providers.microsoft + job.providers.other;
  if (total === 0) return UNKNOWN_PROVIDER;
  const top = dominantProvider(job.providers);
  return top ? PROVIDER_LABELS[top] : MIXED_PROVIDER;
}

/** Whether the run wrote the domain off in the sheet. */
export function wasWrittenOff(job: BlockedDomainJob): boolean {
  if (job.status === "kept") return false;
  if (job.sheet?.statusUpdated) return true;
  // Records from before the sheet outcome was recorded in detail: anything
  // that reached the sheet step and wasn't a kept domain counts.
  return job.phaseStates?.sheet === "done";
}

function group(jobs: BlockedDomainJob[], keyOf: (j: BlockedDomainJob) => string): Breakdown {
  const byKey = new Map<string, BreakdownRow & { seen: Set<string> }>();
  for (const j of jobs) {
    const key = keyOf(j);
    const row = byKey.get(key) ?? {
      key,
      count: 0,
      share: 0,
      writtenOff: 0,
      kept: 0,
      inboxesStopped: 0,
      inboxesDeleted: 0,
      domains: 0,
      seen: new Set<string>(),
    };
    row.count += 1;
    if (j.status === "kept") row.kept += 1;
    if (wasWrittenOff(j)) row.writtenOff += 1;
    row.inboxesStopped += j.inboxesQuarantined ?? 0;
    row.inboxesDeleted += j.inboxesDeleted ?? 0;
    row.seen.add(j.domain);
    byKey.set(key, row);
  }
  const total = jobs.length;
  const rows = [...byKey.values()]
    .map(({ seen, ...r }) => ({ ...r, domains: seen.size, share: total > 0 ? r.count / total : 0 }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  return { total, rows };
}

export function byTld(jobs: BlockedDomainJob[]): Breakdown {
  return group(jobs, (j) => tldKeyOf(j.domain));
}

export function byHost(jobs: BlockedDomainJob[]): Breakdown {
  return group(jobs, hostKeyOf);
}

/** By the mailbox provider the domain was running on. */
export function byProvider(jobs: BlockedDomainJob[]): Breakdown {
  return group(jobs, providerKeyOf);
}

/** Host and ending together — "Spaceship · .co" — the combination that blocks. */
export function byHostAndTld(jobs: BlockedDomainJob[]): Breakdown {
  return group(jobs, (j) => `${hostKeyOf(j)} · ${tldKeyOf(j.domain)}`);
}

/** "42%" with no decimals below 10 groups' worth of noise. */
export function percent(share: number): string {
  const p = share * 100;
  return `${p >= 10 || p === 0 ? Math.round(p) : Math.round(p * 10) / 10}%`;
}
