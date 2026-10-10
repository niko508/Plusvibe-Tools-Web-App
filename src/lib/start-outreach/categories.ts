// What kind of infrastructure a domain runs on, for Start Outreach.
//
// The three kinds send at different volumes and so want different settings,
// and a batch normally mixes them — so a run categorises the domains it is
// given and applies each category's own numbers.
//
//   Google Inboxes   the domain's mailboxes are Google Workspace seats
//   Azure 25         a Microsoft domain with up to 25 mailboxes on it
//   Azure 50         a Microsoft domain with more than that
//
// The Azure split is by MAILBOXES ON THE DOMAIN, counting every one Plusvibe
// reports for it rather than only the ones ready to move: a 50-seat domain
// with 40 warmed is still a 50, and sending it a 25's numbers would throttle
// it for a week. A domain on neither provider has no category and is left for
// someone to look at rather than guessed into one.
//
// Pure module — no API, no clock — so all of it is unit-tested.

import { bucketOf, dominantProvider, emptyProviderCounts, type ProviderCounts } from "@/lib/plusvibe-providers";

export type Category = "google" | "azure25" | "azure50";

export const CATEGORIES: Category[] = ["google", "azure25", "azure50"];

export const CATEGORY_LABELS: Record<Category, string> = {
  google: "Google Inboxes",
  azure25: "Azure 25",
  azure50: "Azure 50",
};

/** The most mailboxes a domain can have and still be an Azure 25. */
export const AZURE_25_MAX = 25;

export function isCategory(v: unknown): v is Category {
  return v === "google" || v === "azure25" || v === "azure50";
}

/** Provider counts from Plusvibe's per-inbox provider keys. */
export function countProviderKeys(providers: [string, number][]): ProviderCounts {
  const counts = emptyProviderCounts();
  for (const [key, n] of providers) counts[bucketOf(key)] += n;
  return counts;
}

/**
 * A domain's category, or null when it is on neither provider — or on a genuine
 * even split of the two, which is a domain to look at rather than to guess at.
 */
export function categoryOf(providers: [string, number][], inboxesOnDomain: number): Category | null {
  const bucket = dominantProvider(countProviderKeys(providers));
  if (bucket === "google") return "google";
  if (bucket === "microsoft") return inboxesOnDomain <= AZURE_25_MAX ? "azure25" : "azure50";
  return null;
}

/** What the page has for each domain it offers. */
export interface DomainLike {
  domain: string;
  /** Every mailbox Plusvibe reports on the domain, ready or not. */
  total: number;
  providers: [string, number][];
}

/** domain → category, for every domain that has one. */
export function categorizeDomains(domains: DomainLike[]): Map<string, Category> {
  const out = new Map<string, Category>();
  for (const d of domains) {
    const c = categoryOf(d.providers, d.total);
    if (c) out.set(d.domain, c);
  }
  return out;
}

// --- Splitting a batch -------------------------------------------------------

export interface CategorizedInbox {
  email: string;
  domain: string;
  category?: Category | null;
}

export interface CategorySplit<T> {
  /** Only the categories actually present, in CATEGORIES order. */
  groups: { category: Category; inboxes: T[] }[];
  /** Inboxes whose domain has no category — never silently lumped in. */
  uncategorized: T[];
}

/**
 * Splits a batch by category, keeping the order of CATEGORIES so the form and
 * the run always read the same way round.
 */
export function splitByCategory<T extends CategorizedInbox>(inboxes: T[]): CategorySplit<T> {
  const by = new Map<Category, T[]>();
  const uncategorized: T[] = [];
  for (const i of inboxes) {
    if (!isCategory(i.category)) {
      uncategorized.push(i);
      continue;
    }
    const list = by.get(i.category);
    if (list) list.push(i);
    else by.set(i.category, [i]);
  }
  return {
    groups: CATEGORIES.filter((c) => by.has(c)).map((c) => ({ category: c, inboxes: by.get(c)! })),
    uncategorized,
  };
}

/** "Google Inboxes ×12 · Azure 50 ×48" — what a batch is made of. */
export function describeSplit(split: CategorySplit<CategorizedInbox>): string {
  const parts = split.groups.map((g) => `${CATEGORY_LABELS[g.category]} ×${g.inboxes.length}`);
  if (split.uncategorized.length > 0) parts.push(`${split.uncategorized.length} uncategorised`);
  return parts.join(" · ");
}
