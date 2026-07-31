import type { EmailAccount } from "@/lib/plusvibe-types";

// --- Numbers & percentages -------------------------------------------------

const numberFmt = new Intl.NumberFormat("en-US");

export function formatNumber(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return "—";
  return numberFmt.format(n);
}

export function formatPercent(n: number | undefined | null, digits = 1): string {
  if (n === undefined || n === null || Number.isNaN(n)) return "—";
  return `${n.toFixed(digits)}%`;
}

// --- Domains ---------------------------------------------------------------

export function domainFromEmail(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at === -1) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain || null;
}

export interface DomainGroup {
  domain: string;
  mailboxes: number;
  accountIds: string[];
}

// Groups accounts by their sending domain, sorted by mailbox count desc.
export function groupByDomain(accounts: EmailAccount[]): DomainGroup[] {
  const map = new Map<string, DomainGroup>();
  for (const acc of accounts) {
    const domain = domainFromEmail(acc.email);
    if (!domain) continue;
    let group = map.get(domain);
    if (!group) {
      group = { domain, mailboxes: 0, accountIds: [] };
      map.set(domain, group);
    }
    group.mailboxes += 1;
    if (acc.id) group.accountIds.push(acc.id);
  }
  return Array.from(map.values()).sort(
    (a, b) => b.mailboxes - a.mailboxes || a.domain.localeCompare(b.domain)
  );
}

// --- Dates -----------------------------------------------------------------

// Formats a Date as YYYY-MM-DD in UTC (matching the API's date semantics).
export function toApiDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function daysAgo(days: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

export function startOfMonth(date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

export interface DateRange {
  start: string;
  end: string;
}

export const DATE_PRESETS: { key: string; label: string; range: () => DateRange }[] = [
  {
    key: "7d",
    label: "Last 7 days",
    range: () => ({ start: toApiDate(daysAgo(6)), end: toApiDate(new Date()) }),
  },
  {
    key: "30d",
    label: "Last 30 days",
    range: () => ({ start: toApiDate(daysAgo(29)), end: toApiDate(new Date()) }),
  },
  {
    key: "90d",
    label: "Last 90 days",
    range: () => ({ start: toApiDate(daysAgo(89)), end: toApiDate(new Date()) }),
  },
  {
    key: "mtd",
    label: "This month",
    range: () => ({ start: toApiDate(startOfMonth()), end: toApiDate(new Date()) }),
  },
];

// --- Health thresholds -----------------------------------------------------

export type Health = "good" | "warn" | "bad" | "neutral";

// Higher reply rate is better.
export function replyRateHealth(rate: number): Health {
  if (rate >= 5) return "good";
  if (rate >= 2) return "warn";
  return "bad";
}

// Lower bounce rate is better.
export function bounceRateHealth(rate: number): Health {
  if (rate <= 2) return "good";
  if (rate <= 5) return "warn";
  return "bad";
}

export function uniqueContacted(header: {
  total_unique_contacted_count?: number;
  total_new_lead_contacted_count?: number;
  total_contacted_count: number;
}): number {
  return (
    header.total_unique_contacted_count ??
    header.total_new_lead_contacted_count ??
    header.total_contacted_count
  );
}
