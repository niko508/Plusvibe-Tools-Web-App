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
    key: "14d",
    label: "Last 14 days",
    range: () => ({ start: toApiDate(daysAgo(13)), end: toApiDate(new Date()) }),
  },
  {
    key: "21d",
    label: "Last 21 days",
    range: () => ({ start: toApiDate(daysAgo(20)), end: toApiDate(new Date()) }),
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

// Reply-rate heat scale — a fine-grained gradient from "super red" (0% reply
// rate) to "super green" (>1%), with the buckets concentrated between 0 and 1%
// where cold-email reply rates actually vary. Buckets 0..10:
//   0.0 | 0.1 | 0.2 | 0.3 | 0.4–0.5 | 0.51–0.6 | 0.61–0.7 | 0.71–0.8 |
//   0.81–0.9 | 0.91–1 | >1%
export function replyRateBucket(rate: number): number {
  if (rate > 1) return 10;
  if (rate <= 0.05) return 0;
  if (rate <= 0.15) return 1;
  if (rate <= 0.25) return 2;
  if (rate <= 0.35) return 3;
  if (rate <= 0.5) return 4;
  if (rate <= 0.6) return 5;
  if (rate <= 0.7) return 6;
  if (rate <= 0.8) return 7;
  if (rate <= 0.9) return 8;
  return 9; // 0.91–1.0
}

// Heat colour (red → amber → green) for a reply-rate value, as a text colour
// plus a translucent background tint for a heatmap-style cell.
export function replyRateHeat(rate: number): { text: string; bg: string } {
  const [r, g, b] = heatRgb(replyRateBucket(rate) / 10);
  return {
    text: `rgb(${r} ${g} ${b})`,
    bg: `rgb(${r} ${g} ${b} / 0.16)`,
  };
}

// Separate heat scale for reply rate *with* OOO, which runs higher than the
// true reply rate. Buckets 0..6:
//   0.0–0.5 | 0.51–1 | 1–1.5 | 1.51–2 | 2.1–2.5 | 2.51–3 | 3%+
export function replyRateOooBucket(rate: number): number {
  if (rate > 3) return 6;
  if (rate <= 0.5) return 0;
  if (rate <= 1) return 1;
  if (rate <= 1.5) return 2;
  if (rate <= 2) return 3;
  if (rate <= 2.5) return 4;
  return 5; // 2.51–3
}

export function replyRateOooHeat(rate: number): { text: string; bg: string } {
  const [r, g, b] = heatRgb(replyRateOooBucket(rate) / 6);
  return {
    text: `rgb(${r} ${g} ${b})`,
    bg: `rgb(${r} ${g} ${b} / 0.16)`,
  };
}

// Bounce rate — lower is better, so this scale is inverted: super green at 0%,
// super red above 2.5%. Buckets 0..5:
//   0–0.5 | 0.51–1 | 1.1–1.5 | 1.51–2 | 2.1–2.5 | 2.5%+
export function bounceRateBucket(rate: number): number {
  if (rate > 2.5) return 5;
  if (rate <= 0.5) return 0;
  if (rate <= 1) return 1;
  if (rate <= 1.5) return 2;
  if (rate <= 2) return 3;
  return 4; // 2.1–2.5
}

export function bounceRateHeat(rate: number): { text: string; bg: string } {
  // Invert (1 - t): a low bounce rate maps to green, a high one to red.
  const [r, g, b] = heatRgb(1 - bounceRateBucket(rate) / 5);
  return {
    text: `rgb(${r} ${g} ${b})`,
    bg: `rgb(${r} ${g} ${b} / 0.16)`,
  };
}

function heatRgb(t: number): [number, number, number] {
  const red = [239, 68, 68];
  const amber = [245, 158, 11];
  const green = [34, 197, 94];
  const lerp = (a: number, b: number, u: number) => Math.round(a + (b - a) * u);
  if (t <= 0.5) {
    const u = t / 0.5;
    return [
      lerp(red[0], amber[0], u),
      lerp(red[1], amber[1], u),
      lerp(red[2], amber[2], u),
    ];
  }
  const u = (t - 0.5) / 0.5;
  return [
    lerp(amber[0], green[0], u),
    lerp(amber[1], green[1], u),
    lerp(amber[2], green[2], u),
  ];
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
