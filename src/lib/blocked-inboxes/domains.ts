// Blocked inboxes, gathered by domain — and the stats built on them.
//
// A domain is "blocked" once any inbox on it has been blocked; the Blocked
// Domains list is those domains, each with its blocked inboxes. The stats
// then count them by ending (TLD), by platform (where the domain was bought)
// and by mailbox provider, which is what says what to buy next time.
//
// The domain-level runs from before the move to inboxes are history, not
// discarded: each was a blocked domain, and it is counted as one, merged with
// any inboxes blocked on the same domain since.
//
// Pure module — no API — so all of it is unit-tested.

import { tldOf, DEFAULT_PLATFORM_TAGS, findPlatformTag } from "@/lib/tags/domain-tags";
import { platformLabel } from "@/lib/blocked-domains/registrar";
import { dominantProvider, PROVIDER_LABELS, type ProviderBucket } from "@/lib/plusvibe-providers";
import type { BlockedDomainJob } from "@/lib/jobs/blocked-domains-types";
import { isBlocked, type BlockedInboxJob, type BlockedInboxStatus } from "@/lib/jobs/blocked-inboxes-types";

export const UNKNOWN_PLATFORM = "Unknown platform";
export const UNKNOWN_TLD = "(no ending)";
export const UNKNOWN_PROVIDER = "Unknown mailbox";
export const MIXED_PROVIDER = "Mixed";

/**
 * A platform, named the way the app's platform tags name it, so "Porkbun"
 * from the sheet and "Porkbun LLC" from the registry land in one row.
 */
export function platformKey(host: string | undefined, registrar: string | undefined): string {
  const h = host?.trim();
  if (h) return findPlatformTag(h, DEFAULT_PLATFORM_TAGS)?.name ?? h;
  const r = registrar?.trim();
  return r ? platformLabel(r) : UNKNOWN_PLATFORM;
}

export interface BlockedInboxRef {
  jobId: string;
  email: string;
  status: BlockedInboxStatus;
  blockedAt: number;
  deletedAt?: number;
}

export interface BlockedDomainEntry {
  domain: string;
  tld: string;
  platform: string;
  /** The provider most of its blocked inboxes were on. */
  provider: string;
  workspaceName?: string;
  /** Blocked inboxes on it, newest first. */
  inboxes: BlockedInboxRef[];
  blockedInboxes: number;
  deletedInboxes: number;
  firstBlockedAt: number;
  lastBlockedAt: number;
  /** Also flagged by the old domain-level automation. */
  fromDomainRun: boolean;
}

function providerName(buckets: (ProviderBucket | undefined)[]): string {
  const counts = { google: 0, microsoft: 0, other: 0 };
  for (const b of buckets) if (b) counts[b] += 1;
  if (counts.google + counts.microsoft + counts.other === 0) return UNKNOWN_PROVIDER;
  const top = dominantProvider(counts);
  return top ? PROVIDER_LABELS[top] : MIXED_PROVIDER;
}

/** Every domain with a blocked inbox, most recently blocked first. */
export function blockedDomains(inboxJobs: BlockedInboxJob[]): BlockedDomainEntry[] {
  const byDomain = new Map<string, BlockedInboxJob[]>();
  for (const j of inboxJobs) {
    if (!isBlocked(j)) continue;
    const list = byDomain.get(j.domain) ?? [];
    list.push(j);
    byDomain.set(j.domain, list);
  }
  const out: BlockedDomainEntry[] = [];
  for (const [domain, jobs] of byDomain) {
    const at = (j: BlockedInboxJob) => j.blockedAt ?? j.createdAt;
    jobs.sort((a, b) => at(b) - at(a));
    const withHost = jobs.find((j) => j.domainHost) ?? jobs.find((j) => j.registrar);
    out.push({
      domain,
      tld: tldOf(domain) ?? UNKNOWN_TLD,
      platform: platformKey(withHost?.domainHost, withHost?.registrar),
      provider: providerName(jobs.map((j) => j.provider)),
      workspaceName: jobs.find((j) => j.workspaceName)?.workspaceName,
      inboxes: jobs.map((j) => ({ jobId: j.id, email: j.email, status: j.status, blockedAt: at(j), deletedAt: j.deletedAt })),
      blockedInboxes: jobs.length,
      deletedInboxes: jobs.filter((j) => j.status === "deleted").length,
      firstBlockedAt: Math.min(...jobs.map(at)),
      lastBlockedAt: Math.max(...jobs.map(at)),
      fromDomainRun: false,
    });
  }
  return out.sort((a, b) => b.lastBlockedAt - a.lastBlockedAt || a.domain.localeCompare(b.domain));
}

/**
 * What the stats count: every domain blocked by either automation, once.
 * An old domain-level run adds the inboxes it stopped and deleted to the
 * domain's counts.
 */
export function statsEntries(inboxJobs: BlockedInboxJob[], domainJobs: BlockedDomainJob[]): BlockedDomainEntry[] {
  const entries = new Map(blockedDomains(inboxJobs).map((e) => [e.domain, e]));
  for (const d of domainJobs) {
    const existing = entries.get(d.domain);
    const stopped = Math.max(d.inboxesQuarantined ?? 0, d.inboxesDeleted ?? 0);
    if (existing) {
      existing.fromDomainRun = true;
      existing.blockedInboxes += stopped;
      existing.deletedInboxes += d.inboxesDeleted ?? 0;
      existing.firstBlockedAt = Math.min(existing.firstBlockedAt, d.createdAt);
      if (existing.platform === UNKNOWN_PLATFORM) existing.platform = platformKey(d.sheet?.domainHost, d.registrar);
      continue;
    }
    const p = d.providers;
    const provider = p && p.google + p.microsoft + p.other > 0
      ? (dominantProvider(p) ? PROVIDER_LABELS[dominantProvider(p)!] : MIXED_PROVIDER)
      : UNKNOWN_PROVIDER;
    entries.set(d.domain, {
      domain: d.domain,
      tld: tldOf(d.domain) ?? UNKNOWN_TLD,
      platform: platformKey(d.sheet?.domainHost, d.registrar),
      provider,
      workspaceName: d.workspaceName,
      inboxes: [],
      blockedInboxes: stopped,
      deletedInboxes: d.inboxesDeleted ?? 0,
      firstBlockedAt: d.createdAt,
      lastBlockedAt: d.createdAt,
      fromDomainRun: true,
    });
  }
  return [...entries.values()];
}

// --- breakdowns ----------------------------------------------------------------

export interface StatRow {
  key: string;
  /** Blocked domains in this group. */
  domains: number;
  /** Of all blocked domains, 0–1. */
  share: number;
  blockedInboxes: number;
  deletedInboxes: number;
}

export interface StatBreakdown {
  total: number;
  rows: StatRow[];
}

function group(entries: BlockedDomainEntry[], keyOf: (e: BlockedDomainEntry) => string): StatBreakdown {
  const rows = new Map<string, StatRow>();
  for (const e of entries) {
    const key = keyOf(e);
    const r = rows.get(key) ?? { key, domains: 0, share: 0, blockedInboxes: 0, deletedInboxes: 0 };
    r.domains += 1;
    r.blockedInboxes += e.blockedInboxes;
    r.deletedInboxes += e.deletedInboxes;
    rows.set(key, r);
  }
  const total = entries.length;
  return {
    total,
    rows: [...rows.values()]
      .map((r) => ({ ...r, share: total > 0 ? r.domains / total : 0 }))
      .sort((a, b) => b.domains - a.domains || b.blockedInboxes - a.blockedInboxes || a.key.localeCompare(b.key)),
  };
}

export const byTld = (e: BlockedDomainEntry[]) => group(e, (x) => x.tld);
export const byPlatform = (e: BlockedDomainEntry[]) => group(e, (x) => x.platform);
export const byProvider = (e: BlockedDomainEntry[]) => group(e, (x) => x.provider);
export const byPlatformAndTld = (e: BlockedDomainEntry[]) => group(e, (x) => `${x.platform} · ${x.tld}`);

/** "42%", with one decimal only below 10%. */
export function percent(share: number): string {
  const p = share * 100;
  return `${p >= 10 || p === 0 ? Math.round(p) : Math.round(p * 10) / 10}%`;
}
