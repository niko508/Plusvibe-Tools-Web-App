// TLD Performance Tracking: turning a month of inbox figures into a table of
// domain ending × registrar, and deciding which combos are worth buying.
//
// Everything is counted per DOMAIN and summed, never averaged:
//
//   reply rate        real replies (no out-of-office) over emails sent
//   vs its clients    the combo's replies over the replies its domains would
//                     have got at their own clients' rate. Which client a
//                     domain sends for decides most of its reply rate, so a
//                     combo bought mostly for a strong client would otherwise
//                     look better than it is. Each inbox's sends are priced at
//                     its own workspace's rate on the same mailbox provider
//   blocked           domains the Blocked Domains automation caught in the
//                     month, out of the domains that sent or were blocked
//
// Pure module — no API calls, no clock — so all of it is unit-tested.

export type ProviderBucket = "google" | "microsoft" | "other";
export type ProviderView = "all" | "microsoft" | "google";
export const PROVIDER_VIEWS: ProviderView[] = ["all", "microsoft", "google"];
export const VIEW_LABELS: Record<ProviderView, string> = { all: "All", microsoft: "Microsoft", google: "Google" };

export const UNKNOWN_PLATFORM = "Unknown platform";
export const NO_TLD = "(no ending)";

/** One inbox's month, already tagged with what it is. */
export interface InboxFigures {
  workspaceId: string;
  workspaceName: string;
  domain: string;
  provider: ProviderBucket;
  sent: number;
  replies: number;
  oooReplies: number;
  bounces: number;
  /** The platform tag the inbox carries in Plusvibe, if any: where the sheet has no Domain Host. */
  platformTag?: string;
}

/** A domain caught by the Blocked Domains automation. */
export interface BlockedDomain {
  domain: string;
  /** Epoch ms of the first block. */
  blockedAt: number;
  provider?: ProviderBucket;
  /** The platform the block record names, for a domain the sheet doesn't list. */
  platform?: string;
}

export type Rating = "best" | "good" | "caution" | "avoid" | "little-data";

export const RATING_LABELS: Record<Rating, string> = {
  best: "Buy",
  good: "OK",
  caution: "Caution",
  avoid: "Avoid",
  "little-data": "Too little data",
};

export interface Rules {
  /** Domains that sent in the month, below which a combo is "too little data". */
  minDomains: number;
  /** Different clients those domains send for, below which it is too. */
  minClients: number;
  /** Registrars no longer bought from: never in "Buy these", whatever their numbers. */
  hiddenPlatforms: string[];
}

export const DEFAULT_RULES: Rules = { minDomains: 15, minClients: 3, hiddenPlatforms: ["Spaceship", "Porkbun"] };

/**
 * The bars, fixed so the answer is the same every month:
 *
 *   Buy       replies at or above what its clients predict, and no block
 *   OK        within 10% of its clients, and under 2% of domains blocked
 *   Avoid     20% or more below its clients, or 5% or more blocked
 *   Caution   anything in between
 */
export const BEST_VS = 1.0;
export const GOOD_VS = 0.9;
export const AVOID_VS = 0.8;
export const GOOD_MAX_BLOCK = 0.02;
export const AVOID_BLOCK = 0.05;

export interface DomainRow {
  domain: string;
  tld: string;
  platform: string;
  provider: ProviderBucket | "mixed";
  /** The workspace that sent the most from it. */
  workspaceName: string;
  inboxes: number;
  sent: number;
  replies: number;
  oooReplies: number;
  bounces: number;
  /** Replies it would have had at its clients' own rates. */
  expected: number;
  /** Epoch ms, when the domain was blocked in the month. */
  blockedAt?: number;
}

export interface ComboRow {
  tld: string;
  platform: string;
  /** Domains that sent in the month. */
  domains: number;
  clients: number;
  sent: number;
  replies: number;
  /** Percent, real replies over sends. */
  replyRate: number;
  /** Percent: the rate its clients would predict. */
  expectedRate: number;
  /** Replies over expected replies: 1.1 means 10% better than its clients. */
  vsClients: number;
  bounces: number;
  bounceRate: number;
  /** Domains blocked in the month. */
  blocked: number;
  /** Domains that sent or were blocked: what the block rate is out of. */
  domainsUsed: number;
  blockRate: number;
  rating: Rating;
  /** On a registrar no longer bought from. */
  hidden: boolean;
  why: string;
}

export interface ViewTotals {
  domains: number;
  sent: number;
  replies: number;
  replyRate: number;
  blocked: number;
}

export interface ReportBody {
  combos: Record<ProviderView, ComboRow[]>;
  totals: Record<ProviderView, ViewTotals>;
  domains: DomainRow[];
  /** Sending domains the sheet has no Domain Host for. */
  unknownPlatform: number;
}

const round = (n: number, places = 2) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

/** The ending after the last dot, with the dot: "mail.example.co" → ".co". */
export function tldOfDomain(domain: string): string {
  const d = domain.trim().toLowerCase();
  const i = d.lastIndexOf(".");
  return i > 0 && i < d.length - 1 ? d.slice(i) : NO_TLD;
}

/**
 * A platform as the page shows it: the tag's name with a capital, so the
 * "dynadot" tag and "Dynadot" from the sheet read the same.
 */
export function displayPlatform(name: string): string {
  const n = name.trim();
  return n ? n.charAt(0).toUpperCase() + n.slice(1) : n;
}

/** The tag most of a domain's inboxes carry; ties go to the first seen. */
function majorityTag(list: InboxFigures[]): string | undefined {
  const counts = new Map<string, number>();
  for (const i of list) if (i.platformTag) counts.set(i.platformTag, (counts.get(i.platformTag) ?? 0) + 1);
  let best: string | undefined;
  let n = 0;
  for (const [tag, c] of counts) if (c > n) [best, n] = [tag, c];
  return best;
}

/** The domain of an address, lowercased; "" when there is none. */
export function domainOfEmail(email: string): string {
  const at = email.lastIndexOf("@");
  return at > 0 ? email.slice(at + 1).trim().toLowerCase() : "";
}

function hiddenSet(rules: Rules): Set<string> {
  return new Set(rules.hiddenPlatforms.map((p) => p.trim().toLowerCase()).filter(Boolean));
}

/**
 * Each workspace's real-reply rate on each provider, over its sends: what an
 * email from that client, on that kind of mailbox, usually gets.
 */
export function workspaceRates(inboxes: InboxFigures[]): Map<string, number> {
  const sums = new Map<string, { sent: number; replies: number }>();
  for (const i of inboxes) {
    const key = `${i.workspaceId}|${i.provider}`;
    const s = sums.get(key) ?? { sent: 0, replies: 0 };
    s.sent += i.sent;
    s.replies += i.replies;
    sums.set(key, s);
  }
  const out = new Map<string, number>();
  for (const [key, s] of sums) out.set(key, s.sent > 0 ? s.replies / s.sent : 0);
  return out;
}

/**
 * One row per domain that sent in the month, plus one per domain blocked in
 * it that no longer has inboxes to read.
 *
 * The registrar comes from, in order: `platformOf` (the sheet's Domain Host),
 * the platform tag most of the domain's inboxes carry, the block record.
 */
export function domainRows(
  inboxes: InboxFigures[],
  blocked: BlockedDomain[],
  platformOf: (domain: string) => string | undefined
): DomainRow[] {
  const rates = workspaceRates(inboxes);
  const byDomain = new Map<string, InboxFigures[]>();
  for (const i of inboxes) {
    if (!i.domain || i.sent <= 0) continue;
    const list = byDomain.get(i.domain);
    if (list) list.push(i);
    else byDomain.set(i.domain, [i]);
  }
  const blockedBy = new Map(blocked.map((b) => [b.domain, b]));

  const rows: DomainRow[] = [];
  for (const [domain, list] of byDomain) {
    const sum = (pick: (i: InboxFigures) => number) => list.reduce((n, i) => n + pick(i), 0);
    const perWs = new Map<string, { name: string; sent: number }>();
    for (const i of list) {
      const w = perWs.get(i.workspaceId) ?? { name: i.workspaceName, sent: 0 };
      w.sent += i.sent;
      perWs.set(i.workspaceId, w);
    }
    const main = [...perWs.values()].sort((a, b) => b.sent - a.sent)[0];
    const providers = new Set(list.map((i) => i.provider));
    const b = blockedBy.get(domain);
    rows.push({
      domain,
      tld: tldOfDomain(domain),
      platform: displayPlatform(platformOf(domain) || majorityTag(list) || b?.platform || "") || UNKNOWN_PLATFORM,
      provider: providers.size === 1 ? [...providers][0] : "mixed",
      workspaceName: main?.name ?? "",
      inboxes: list.length,
      sent: sum((i) => i.sent),
      replies: sum((i) => i.replies),
      oooReplies: sum((i) => i.oooReplies),
      bounces: sum((i) => i.bounces),
      expected: round(sum((i) => i.sent * (rates.get(`${i.workspaceId}|${i.provider}`) ?? 0)), 4),
      ...(b ? { blockedAt: b.blockedAt } : {}),
    });
  }
  // Blocked and already gone: no figures, but it was bought and it was lost.
  for (const b of blocked) {
    if (byDomain.has(b.domain)) continue;
    rows.push({
      domain: b.domain,
      tld: tldOfDomain(b.domain),
      platform: displayPlatform(platformOf(b.domain) || b.platform || "") || UNKNOWN_PLATFORM,
      provider: b.provider ?? "other",
      workspaceName: "",
      inboxes: 0,
      sent: 0,
      replies: 0,
      oooReplies: 0,
      bounces: 0,
      expected: 0,
      blockedAt: b.blockedAt,
    });
  }
  return rows.sort((a, b) => b.sent - a.sent || a.domain.localeCompare(b.domain));
}

function inView(row: DomainRow, view: ProviderView): boolean {
  return view === "all" || row.provider === view;
}

/** The rating for one combo, and why, in words. */
export function rate(
  c: { domains: number; clients: number; vsClients: number; blocked: number; blockRate: number },
  rules: Rules
): { rating: Rating; why: string } {
  const vs = `${Math.round(Math.abs(c.vsClients - 1) * 100)}% ${c.vsClients >= 1 ? "above" : "below"} what its clients predict`;
  if (c.domains < rules.minDomains || c.clients < rules.minClients) {
    return {
      rating: "little-data",
      why: `Only ${c.domains} domain${c.domains === 1 ? "" : "s"} across ${c.clients} client${c.clients === 1 ? "" : "s"} — needs ${rules.minDomains}+ across ${rules.minClients}+ to judge.`,
    };
  }
  if (c.vsClients < AVOID_VS || c.blockRate >= AVOID_BLOCK) {
    return {
      rating: "avoid",
      why: c.blockRate >= AVOID_BLOCK ? `${c.blocked} blocked (${round(c.blockRate * 100, 1)}%). Replies ${vs}.` : `Replies ${vs}.`,
    };
  }
  if (c.vsClients >= BEST_VS && c.blocked === 0) return { rating: "best", why: `Replies ${vs}, and none blocked.` };
  if (c.vsClients >= GOOD_VS && c.blockRate < GOOD_MAX_BLOCK) {
    return { rating: "good", why: `Replies ${vs}${c.blocked ? `, ${c.blocked} blocked` : ", none blocked"}.` };
  }
  return { rating: "caution", why: `Replies ${vs}${c.blocked ? `, ${c.blocked} blocked (${round(c.blockRate * 100, 1)}%)` : ""}.` };
}

const RANK: Record<Rating, number> = { best: 0, good: 1, caution: 2, avoid: 3, "little-data": 4 };

/** Domain ending × registrar for one provider view, best first. */
export function combos(rows: DomainRow[], view: ProviderView, rules: Rules): ComboRow[] {
  const hidden = hiddenSet(rules);
  const groups = new Map<string, DomainRow[]>();
  for (const r of rows) {
    if (!inView(r, view)) continue;
    const key = `${r.tld}|${r.platform}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  const out: ComboRow[] = [];
  for (const list of groups.values()) {
    const sending = list.filter((r) => r.sent > 0);
    const sum = (pick: (r: DomainRow) => number) => sending.reduce((n, r) => n + pick(r), 0);
    const sent = sum((r) => r.sent);
    const replies = sum((r) => r.replies);
    const expected = sum((r) => r.expected);
    const bounces = sum((r) => r.bounces);
    const blocked = list.filter((r) => r.blockedAt !== undefined).length;
    const domainsUsed = list.length;
    const base = {
      tld: list[0].tld,
      platform: list[0].platform,
      domains: sending.length,
      clients: new Set(sending.map((r) => r.workspaceName).filter(Boolean)).size,
      sent,
      replies,
      replyRate: sent > 0 ? round((replies / sent) * 100) : 0,
      expectedRate: sent > 0 ? round((expected / sent) * 100) : 0,
      vsClients: expected > 0 ? round(replies / expected) : 0,
      bounces,
      bounceRate: sent > 0 ? round((bounces / sent) * 100) : 0,
      blocked,
      domainsUsed,
      blockRate: domainsUsed > 0 ? round(blocked / domainsUsed, 4) : 0,
      hidden: hidden.has(list[0].platform.toLowerCase()),
    };
    out.push({ ...base, ...rate(base, rules) });
  }
  return out.sort(
    (a, b) =>
      RANK[a.rating] - RANK[b.rating] ||
      Number(a.hidden) - Number(b.hidden) ||
      b.vsClients - a.vsClients ||
      b.domains - a.domains ||
      a.tld.localeCompare(b.tld) ||
      a.platform.localeCompare(b.platform)
  );
}

export function totals(rows: DomainRow[], view: ProviderView): ViewTotals {
  const list = rows.filter((r) => inView(r, view));
  const sending = list.filter((r) => r.sent > 0);
  const sent = sending.reduce((n, r) => n + r.sent, 0);
  const replies = sending.reduce((n, r) => n + r.replies, 0);
  return {
    domains: sending.length,
    sent,
    replies,
    replyRate: sent > 0 ? round((replies / sent) * 100) : 0,
    blocked: list.filter((r) => r.blockedAt !== undefined).length,
  };
}

export function buildReport(
  inboxes: InboxFigures[],
  blocked: BlockedDomain[],
  platformOf: (domain: string) => string | undefined,
  rules: Rules
): ReportBody {
  const domains = domainRows(inboxes, blocked, platformOf);
  const by = <T,>(fn: (v: ProviderView) => T) =>
    Object.fromEntries(PROVIDER_VIEWS.map((v) => [v, fn(v)])) as Record<ProviderView, T>;
  return {
    combos: by((v) => combos(domains, v, rules)),
    totals: by((v) => totals(domains, v)),
    domains,
    unknownPlatform: domains.filter((d) => d.sent > 0 && d.platform === UNKNOWN_PLATFORM).length,
  };
}

/**
 * The combos to buy: rated best, on a registrar still bought from — and one
 * that is known, since "Unknown platform" can't be bought from.
 */
export function buyThese(rows: ComboRow[]): ComboRow[] {
  return rows.filter((r) => r.rating === "best" && !r.hidden && r.platform !== UNKNOWN_PLATFORM);
}

// --- What comes out ----------------------------------------------------------

function cell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const COMBO_CSV_HEADERS = [
  "tld", "registrar", "rating", "domains", "clients", "emails_sent", "replies", "reply_rate",
  "expected_rate", "vs_clients", "bounces", "bounce_rate", "blocked", "domains_used", "block_rate", "why",
];

export function combosCsv(rows: ComboRow[]): string {
  const lines = [COMBO_CSV_HEADERS.join(",")];
  for (const r of rows) {
    lines.push(
      [r.tld, r.platform, RATING_LABELS[r.rating], r.domains, r.clients, r.sent, r.replies, r.replyRate,
        r.expectedRate, r.vsClients, r.bounces, r.bounceRate, r.blocked, r.domainsUsed, round(r.blockRate * 100, 1), r.why]
        .map(cell)
        .join(",")
    );
  }
  return lines.join("\n");
}

export const DOMAIN_CSV_HEADERS = [
  "domain", "tld", "registrar", "provider", "workspace", "inboxes", "emails_sent", "replies",
  "ooo_replies", "bounces", "expected_replies", "blocked",
];

export function domainsCsv(rows: DomainRow[]): string {
  const lines = [DOMAIN_CSV_HEADERS.join(",")];
  for (const r of rows) {
    lines.push(
      [r.domain, r.tld, r.platform, r.provider, r.workspaceName, r.inboxes, r.sent, r.replies, r.oooReplies,
        r.bounces, r.expected, r.blockedAt !== undefined ? "yes" : "no"]
        .map(cell)
        .join(",")
    );
  }
  return lines.join("\n");
}

/** "October 2026" */
export function monthName(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${names[(m || 1) - 1] ?? month} ${y}`;
}

/**
 * The grid written to the sheet: the combos to buy on top, every combo below.
 * Rates go in as "0.53%" so Sheets stores real percentages.
 */
export function sheetGrid(r: { month: string; combos: ComboRow[]; totals: ViewTotals; view: ProviderView; updated: string }): string[][] {
  const buy = buyThese(r.combos);
  const pct = (n: number) => `${n}%`;
  const grid: string[][] = [
    [`TLD Performance · ${monthName(r.month)}${r.view === "all" ? "" : ` · ${VIEW_LABELS[r.view]}`}`],
    [
      `Updated ${r.updated} by Plusvibe Tools. ${r.totals.domains.toLocaleString("en-US")} domains sent ${r.totals.sent.toLocaleString("en-US")} emails at ${r.totals.replyRate}% real replies.`,
    ],
    [],
    ["Buy these", "Registrar", "Reply rate", "Vs its clients", "Domains", "Clients", "Blocked this month"],
  ];
  if (buy.length === 0) grid.push(["No combo cleared the bar this month — keep to last month's list."]);
  for (const c of buy) grid.push([c.tld, c.platform, pct(c.replyRate), `${c.vsClients}x`, String(c.domains), String(c.clients), String(c.blocked)]);
  grid.push([], ["Every combo", "Registrar", "Rating", "Domains", "Clients", "Emails sent", "Replies", "Reply rate", "Expected from clients", "Vs its clients", "Bounce rate", "Blocked", "Block rate", "Why"]);
  for (const c of r.combos) {
    grid.push([
      c.tld, c.platform, `${RATING_LABELS[c.rating]}${c.hidden ? " (not buying)" : ""}`, String(c.domains), String(c.clients),
      String(c.sent), String(c.replies), pct(c.replyRate), pct(c.expectedRate), `${c.vsClients}x`, pct(c.bounceRate),
      String(c.blocked), pct(round(c.blockRate * 100, 1)), c.why,
    ]);
  }
  return grid;
}
