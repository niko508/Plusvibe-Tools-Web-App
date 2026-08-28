// Sender ESP (the provider each mailbox sends through), as reported by the
// `provider` field on /account/list. Plusvibe returns three values; anything
// unrecognised is bucketed as REGULAR_ACCOUNT by providerBucket().

// Sentinel for "every ESP". It has to be a real value rather than null,
// because null now means "the user hasn't picked a type yet" — and until they
// have, the tool deliberately fetches no per-domain stats.
export const ALL_ESP = "ALL";

export const ESP_OPTIONS: { key: string; label: string }[] = [
  { key: ALL_ESP, label: "All" },
  { key: "GOOGLE_WORKSPACE", label: "Google" },
  { key: "MICROSOFT365", label: "Microsoft" },
  { key: "REGULAR_ACCOUNT", label: "Other / SMTP" },
];

export function providerLabel(key: string): string {
  return ESP_OPTIONS.find((o) => o.key === key)?.label ?? key;
}

// Whether a domain belongs to the selected ESP view. ALL_ESP matches every
// domain; a mixed domain matches each ESP it has mailboxes on.
export function matchesEsp(providers: string[], esp: string): boolean {
  return esp === ALL_ESP || providers.includes(esp);
}

// Short form for the table badge, where column width is tight.
const SHORT: Record<string, string> = {
  GOOGLE_WORKSPACE: "Google",
  MICROSOFT365: "Microsoft",
  REGULAR_ACCOUNT: "SMTP",
};

export function providerShort(key: string): string {
  return SHORT[key] ?? key;
}

// Tailwind classes per provider. Literal strings — Tailwind can't see
// class names built at runtime.
export const PROVIDER_BADGE: Record<string, string> = {
  GOOGLE_WORKSPACE: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  MICROSOFT365: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  REGULAR_ACCOUNT: "bg-muted text-muted-foreground",
  MIXED: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
};

/**
 * How a domain's mailboxes are split across ESPs.
 *
 * A domain is usually all one provider, but nothing stops it being mixed — and
 * that matters, because Plusvibe reports campaign stats per DOMAIN, not per
 * mailbox. A mixed domain's numbers can't be attributed to one ESP, so it's
 * labelled "Mixed" and its breakdown shown on hover.
 */
export function providerSummary(providers: string[]): {
  key: string;
  label: string;
  mixed: boolean;
} {
  if (providers.length === 0) return { key: "REGULAR_ACCOUNT", label: "—", mixed: false };
  if (providers.length === 1) {
    return { key: providers[0], label: providerShort(providers[0]), mixed: false };
  }
  return { key: "MIXED", label: "Mixed", mixed: true };
}

// "60 Google · 40 Microsoft" — the per-ESP mailbox breakdown for a tooltip.
export function providerBreakdown(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => `${n} ${providerShort(key)}`)
    .join(" · ");
}
