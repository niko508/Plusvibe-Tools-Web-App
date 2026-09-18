// Classifies a lead's mailbox provider.
//
// Plusvibe knows recipient ESP internally (its email-stats endpoint takes a
// `recp_provider` filter), but the lead objects returned by
// /lead/workspace-leads are not documented to carry it. So we check the lead
// for a provider field first and fall back to an MX lookup on its domain.
//
// MX lookups are per-DOMAIN, not per-lead: 20k leads typically share a few
// thousand domains, and the cache means each is resolved once per run.

export type Esp = "MICROSOFT" | "GOOGLE" | "OTHER";

// Substrings that identify a provider in an MX hostname. Matched against the
// lowercased exchange host, longest-signal-first is not needed because the two
// sets are disjoint in practice.
const MICROSOFT_MX = [
  "outlook.com", // covers *.mail.protection.outlook.com (M365) and outlook.com
  "office365.com",
  "microsoft.com",
  "hotmail.com",
  "messaging.microsoft.com",
];

const GOOGLE_MX = [
  "google.com", // aspmx.l.google.com, *.googlemail.com below
  "googlemail.com",
  "gmail.com",
];

/**
 * Classifies from a domain's MX exchange hostnames.
 *
 * A domain with no MX records is OTHER, not Microsoft — an unroutable domain
 * must never land in the Microsoft bucket, because that bucket drives which
 * campaign (and so which sending infrastructure) a lead is contacted from.
 */
export function classifyMx(exchanges: string[]): Esp {
  const hosts = exchanges.map((h) => h.toLowerCase().replace(/\.$/, ""));
  for (const host of hosts) {
    if (MICROSOFT_MX.some((m) => host.endsWith(m))) return "MICROSOFT";
  }
  for (const host of hosts) {
    if (GOOGLE_MX.some((g) => host.endsWith(g))) return "GOOGLE";
  }
  return "OTHER";
}

/**
 * Maps a provider value Plusvibe may already carry on a lead onto our buckets.
 * Same vocabulary as the account `provider` field. Returns null when the value
 * is absent or unrecognised, so the caller falls back to MX.
 */
export function classifyProviderField(value: unknown): Esp | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const v = value.trim().toUpperCase();
  if (v.includes("MICROSOFT") || v.includes("OUTLOOK") || v.includes("365")) {
    return "MICROSOFT";
  }
  if (v.includes("GOOGLE") || v.includes("GMAIL") || v.includes("WORKSPACE")) {
    return "GOOGLE";
  }
  if (v.includes("REGULAR") || v.includes("SMTP") || v.includes("OTHER")) {
    return "OTHER";
  }
  return null;
}

export function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 0) return "";
  return email.slice(at + 1).trim().toLowerCase();
}
