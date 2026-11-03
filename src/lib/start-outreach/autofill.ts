// Picking a batch by size instead of by hand.
//
// "Give me 400 Microsoft inboxes" is the real question — which particular
// domains carry them almost never matters, and ticking forty boxes to find out
// is the slow way to ask it.
//
// A domain is all-or-nothing: its ready inboxes move together or not at all,
// because the settings, the tags and the sheet row all belong to the domain
// rather than to one mailbox. So a target is rarely hit exactly, and this
// fills UP TO it and never past it: 7 asked of domains carrying 3 each is 6,
// not 9. The page says so, so nobody has to work out why they got 6.
//
// OLDEST FIRST. The domains that have been warming longest go out first —
// they have been sitting idle the longest, and a domain left behind while
// younger ones go out is warming for nothing. Age decides before anything
// else; size only breaks a tie between domains warmed the same length.
//
// Within that order it skips any domain that would overshoot and carries on,
// so it still lands exactly on the target whenever the domains are the same
// size (which they usually are) rather than stopping at the first one that
// does not fit. A perfect fit would be a subset-sum search, which for a
// handful of inboxes is not worth the time or the unpredictability — two runs
// of the same numbers should pick the same domains.
//
// Pure module — no API, no clock — so all of it is unit-tested.

import { countProviderKeys } from "@/lib/start-outreach/categories";
import { dominantProvider, type ProviderBucket } from "@/lib/plusvibe-providers";

/** The two the page offers: the providers a batch is ever asked for by name. */
export type FillProvider = Extract<ProviderBucket, "google" | "microsoft">;

export const FILL_PROVIDERS: FillProvider[] = ["google", "microsoft"];

export const FILL_PROVIDER_LABELS: Record<FillProvider, string> = {
  google: "Google",
  microsoft: "Microsoft",
};

/** What the fill needs from each domain on the page. */
export interface FillableDomain {
  domain: string;
  /** Inboxes that would actually move — the ready ones. */
  ready: number;
  /** Inboxes per provider key, as Plusvibe reports them. */
  providers: [string, number][];
  /** Days warmed — the longest among its inboxes. Null when nothing dates it. */
  days: number | null;
}

export interface FillResult {
  /** The domains to tick, in the order they were taken. */
  domains: string[];
  /** Inboxes those domains carry — what would move. */
  inboxes: number;
  /** What was asked for, after being read as a number. */
  wanted: number;
  /** Ready inboxes on that provider, across every domain offered. */
  available: number;
  /**
   * Why the total is not what was asked for. Null when it landed exactly.
   *
   *   "rounded-down"  whole domains cannot add up to it
   *   "short"         there are not that many on this provider at all
   */
  shortfall: "rounded-down" | "short" | null;
}

/** Which provider a domain counts as, or null when it is on neither. */
export function providerOfDomain(providers: [string, number][]): ProviderBucket | null {
  return dominantProvider(countProviderKeys(providers));
}

/**
 * The domains to tick to move about `want` inboxes on `provider`, oldest
 * first.
 *
 * Never returns more than `want` inboxes. Domains with nothing ready are left
 * out — ticking one would add a name to the list and no inboxes to the batch.
 */
export function fillDomains(
  domains: FillableDomain[],
  provider: FillProvider,
  want: number
): FillResult {
  const wanted = Math.max(0, Math.floor(want));
  const candidates = domains
    .filter((d) => d.ready > 0 && providerOfDomain(d.providers) === provider)
    // Longest warmed first; then biggest, then by name, so the same numbers
    // always pick the same domains — a selection that shuffled between runs
    // would be untrustworthy. A domain with no date at all goes last: it
    // cannot be shown to be older than one that has been counted.
    .sort(
      (a, b) =>
        (b.days ?? -1) - (a.days ?? -1) ||
        b.ready - a.ready ||
        a.domain.localeCompare(b.domain)
    );
  const available = candidates.reduce((n, d) => n + d.ready, 0);

  const picked: string[] = [];
  let inboxes = 0;
  if (wanted > 0) {
    for (const d of candidates) {
      if (inboxes === wanted) break;
      if (inboxes + d.ready > wanted) continue; // would overshoot — skip it
      picked.push(d.domain);
      inboxes += d.ready;
    }
  }

  return {
    domains: picked,
    inboxes,
    wanted,
    available,
    shortfall:
      inboxes === wanted ? null : wanted > available ? "short" : "rounded-down",
  };
}

/** What the page says once a fill has been worked out. */
export function describeFill(r: FillResult, provider: FillProvider): string {
  const label = FILL_PROVIDER_LABELS[provider];
  if (r.wanted === 0) return `Type how many ${label} inboxes to move.`;
  if (r.available === 0) return `No ${label} domains are ready.`;
  const picked = `${r.inboxes.toLocaleString()} inbox${r.inboxes === 1 ? "" : "es"} on ${r.domains.length.toLocaleString()} domain${r.domains.length === 1 ? "" : "s"}`;
  if (r.shortfall === null) return `${picked} — exactly ${r.wanted.toLocaleString()}.`;
  if (r.shortfall === "short") {
    return `${picked} — every ${label} inbox that is ready, ${(r.wanted - r.available).toLocaleString()} short of ${r.wanted.toLocaleString()}.`;
  }
  return `${picked} — ${r.wanted.toLocaleString()} is not a whole number of domains, so it rounds down.`;
}
