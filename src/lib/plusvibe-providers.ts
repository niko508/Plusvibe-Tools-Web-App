// What kind of mailbox an inbox is, from the `provider` Plusvibe reports on
// /account/list.
//
// Shared because two tools ask the same question of the same field: Update
// Inbox Tags scopes its rules by it, and Blocked Domains records which kind of
// infrastructure a blocked domain was running on.
//
// Pure module — no API calls — so all of it is unit-tested.

export type ProviderBucket = "google" | "microsoft" | "other";

export const PROVIDER_BUCKETS: ProviderBucket[] = ["google", "microsoft", "other"];

export const PROVIDER_LABELS: Record<ProviderBucket, string> = {
  google: "Google",
  microsoft: "Microsoft",
  other: "Other",
};

/** Which bucket an inbox falls in, from the provider string Plusvibe reports. */
export function bucketOf(provider: string | undefined | null): ProviderBucket {
  const p = String(provider ?? "").toUpperCase();
  if (p === "GOOGLE_WORKSPACE") return "google";
  if (p === "MICROSOFT365") return "microsoft";
  return "other";
}

export type ProviderCounts = Record<ProviderBucket, number>;

export function emptyProviderCounts(): ProviderCounts {
  return { google: 0, microsoft: 0, other: 0 };
}

export function countProviders(
  inboxes: { provider?: string | null }[]
): ProviderCounts {
  const c = emptyProviderCounts();
  for (const i of inboxes) c[bucketOf(i.provider)] += 1;
  return c;
}

/**
 * The bucket most of a domain's inboxes are on, or null when it is genuinely
 * split.
 *
 * A domain normally sits entirely on one tenant, so naming that tenant is the
 * useful answer. "Mixed" is reserved for a real tie rather than being used
 * whenever a stray inbox differs, because a 49/1 split is not a mixed domain.
 */
export function dominantProvider(counts: ProviderCounts): ProviderBucket | null {
  const ranked = PROVIDER_BUCKETS.filter((b) => counts[b] > 0).sort(
    (a, b) => counts[b] - counts[a]
  );
  if (ranked.length === 0) return null;
  if (ranked.length > 1 && counts[ranked[0]] === counts[ranked[1]]) return null;
  return ranked[0];
}

/** "46 Microsoft · 2 Google" — the mix, biggest first, zeroes left out. */
export function describeProviders(counts: ProviderCounts): string {
  return PROVIDER_BUCKETS.filter((b) => counts[b] > 0)
    .sort((a, b) => counts[b] - counts[a])
    .map((b) => `${counts[b]} ${PROVIDER_LABELS[b]}`)
    .join(" · ");
}
