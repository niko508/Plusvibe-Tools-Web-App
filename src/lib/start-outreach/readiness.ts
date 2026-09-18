// Start Outreach with New Inboxes, phase 1: which inboxes in a workspace have
// warmed long enough to be moved on and put to work.
//
// The one fact this rests on is `warmup_enb_dt`, the moment Plusvibe last
// switched warmup on for the inbox. "Warming for 14 days" is measured from
// that, so an inbox whose warmup was switched off and on again a week ago
// reads as 7 days, whatever it did before. That is the honest reading of the
// field, and it is said on the page.
//
// Pure module — no API, no clock of its own — so all of it is unit-tested.

export const DAY_MS = 86_400_000;
export const DEFAULT_MIN_WARMUP_DAYS = 14;
export const MAX_MIN_WARMUP_DAYS = 365;

/** Reads the "at least N days" box. */
export function parseMinDays(raw: string): { value: number; problem: string | null } {
  const t = (raw ?? "").trim();
  if (t === "") return { value: DEFAULT_MIN_WARMUP_DAYS, problem: "Set how many days of warmup to require." };
  const n = Number(t);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { value: DEFAULT_MIN_WARMUP_DAYS, problem: "Days must be a whole number." };
  }
  if (n < 0 || n > MAX_MIN_WARMUP_DAYS) {
    return {
      value: DEFAULT_MIN_WARMUP_DAYS,
      problem: `Days must be between 0 and ${MAX_MIN_WARMUP_DAYS}.`,
    };
  }
  return { value: n, problem: null };
}

/**
 * A Plusvibe timestamp as epoch milliseconds, or null when it cannot be read.
 * ISO strings are the documented form; a bare number is taken as seconds when
 * it is too small to be milliseconds.
 */
export function parseWhen(raw: string | number | undefined | null): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "number") return normalizeEpoch(raw);
  const t = String(raw).trim();
  if (/^\d+$/.test(t)) return normalizeEpoch(Number(t));
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

function normalizeEpoch(n: number): number | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

/** Whole days since warmup was switched on, or null when that is unknown. */
export function warmupDays(enabledAt: string | number | undefined | null, now: number): number | null {
  const at = parseWhen(enabledAt);
  if (at === null) return null;
  return Math.max(0, Math.floor((now - at) / DAY_MS));
}

// --- Where the start date comes from ----------------------------------------
//
// The Email Infra sheet records when each DOMAIN started warming, and that is
// the number the team goes by. Plusvibe's own timestamp is the fallback for
// domains the sheet has no date for. Both are per domain in effect: every
// inbox on a domain shares the sheet's date.

export type StartSource = "sheet" | "plusvibe" | "none";

/** What the sheet says about one domain, as the raw cells. */
export interface SheetWarmup {
  started?: string;
  days?: string | number;
  /** The "Domain Host" cell (registrar), used for the platform tag. */
  host?: string;
  /** The "Client" cell as it is now, before a move writes the new one. */
  client?: string;
}

export const SHEET_COL_DOMAIN = "Domain";
export const SHEET_COL_WARMUP_STARTED = "Warmup Started";
export const SHEET_COL_WARMUP_DAYS = "Warmup Days";
export const SHEET_COL_DOMAIN_HOST = "Domain Host";
export const SHEET_COL_CLIENT = "Client";

function headerIndex(header: string[], name: string): number {
  const want = name.trim().toLowerCase();
  return header.findIndex((h) => String(h ?? "").trim().toLowerCase() === want);
}

/** Lower-cased, trimmed, no trailing dot — the key both sides are matched on. */
export function normalizeDomain(raw: string | undefined): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .replace(/\.+$/, "");
}

/** Lower-cased and trimmed, with the domain part cleaned the same way. */
export function normalizeEmail(raw: string | undefined): string {
  const t = String(raw ?? "").trim().toLowerCase();
  const at = t.lastIndexOf("@");
  if (at === -1) return t;
  return `${t.slice(0, at)}@${normalizeDomain(t.slice(at + 1))}`;
}

/**
 * Reads the Domains tab into a per-domain lookup. Missing columns give an
 * empty map rather than an error: the caller then simply falls back to
 * Plusvibe for everything, and says so.
 */
export function warmupFromGrid(grid: string[][]): {
  byDomain: Map<string, SheetWarmup>;
  problem: string | null;
} {
  const byDomain = new Map<string, SheetWarmup>();
  if (grid.length === 0) return { byDomain, problem: "The sheet tab is empty." };
  const header = grid[0];
  const iDomain = headerIndex(header, SHEET_COL_DOMAIN);
  const iStarted = headerIndex(header, SHEET_COL_WARMUP_STARTED);
  const iDays = headerIndex(header, SHEET_COL_WARMUP_DAYS);
  const iHost = headerIndex(header, SHEET_COL_DOMAIN_HOST);
  const iClient = headerIndex(header, SHEET_COL_CLIENT);
  if (iDomain === -1) return { byDomain, problem: `No "${SHEET_COL_DOMAIN}" column.` };
  if (iStarted === -1 && iDays === -1) {
    return {
      byDomain,
      problem: `No "${SHEET_COL_WARMUP_STARTED}" or "${SHEET_COL_WARMUP_DAYS}" column.`,
    };
  }
  const cell = (row: string[], i: number) => (i === -1 ? "" : String(row[i] ?? "").trim());
  // A dash is how the sheet says "none".
  const value = (s: string) => (s && s !== "-" && s !== "–" ? s : undefined);
  for (const row of grid.slice(1)) {
    const domain = normalizeDomain(row[iDomain]);
    if (!domain || byDomain.has(domain)) continue; // first row wins
    // A row with blank cells is still a row: the domain is in the sheet, it
    // just has no date (so Plusvibe's is used) and no host or client yet.
    byDomain.set(domain, {
      started: value(cell(row, iStarted)),
      days: value(cell(row, iDays)),
      host: value(cell(row, iHost)),
      client: value(cell(row, iClient)),
    });
  }
  return { byDomain, problem: null };
}

/**
 * The moment warmup started for an inbox, sheet first, then Plusvibe.
 *
 * The sheet's "Warmup Started" date is what the team goes by. If that cell is
 * blank but "Warmup Days" holds a number, the start is worked back from it.
 * Only when the sheet has nothing does Plusvibe's own timestamp count.
 */
export function resolveWarmupStart(
  sheet: SheetWarmup | undefined,
  plusvibeEnabledAt: string | number | undefined,
  now: number
): { at: number | null; source: StartSource } {
  const fromSheet = parseWhen(sheet?.started);
  if (fromSheet !== null) return { at: fromSheet, source: "sheet" };
  const days = sheet?.days === undefined || sheet.days === "" ? NaN : Number(sheet.days);
  if (Number.isFinite(days) && days >= 0) {
    return { at: now - Math.floor(days) * DAY_MS, source: "sheet" };
  }
  const fromPlusvibe = parseWhen(plusvibeEnabledAt);
  if (fromPlusvibe !== null) return { at: fromPlusvibe, source: "plusvibe" };
  return { at: null, source: "none" };
}

export type Verdict =
  /** Warmup on, long enough, and free to be put to work. */
  | "ready"
  | "warmup-off"
  /** Warmup is on but Plusvibe gave no usable start time. */
  | "no-start-date"
  | "too-new"
  /** Already attached to a campaign, so not a new inbox. */
  | "in-campaign";

export const VERDICT_LABELS: Record<Verdict, string> = {
  ready: "Ready",
  "warmup-off": "Warmup off",
  "no-start-date": "No warmup start date",
  "too-new": "Still warming",
  "in-campaign": "Already in a campaign",
};

export interface Candidate {
  warmupStatus?: string;
  warmupEnabledAt?: string | number;
  campaignIds?: string[];
}

export interface Rules {
  /** Days of warmup required. */
  minDays: number;
  /** Leave out inboxes that are already attached to a campaign. */
  skipInCampaign: boolean;
}

export const DEFAULT_RULES: Rules = { minDays: DEFAULT_MIN_WARMUP_DAYS, skipInCampaign: true };

export function warmupIsOn(status: string | undefined): boolean {
  return String(status ?? "").trim().toUpperCase() === "ACTIVE";
}

/**
 * Judges one inbox. Order matters: an inbox with warmup off is never called
 * "too new", and one with no start date is never called ready on a guess.
 */
export function judge(c: Candidate, rules: Rules, now: number): { verdict: Verdict; days: number | null } {
  const days = warmupDays(c.warmupEnabledAt, now);
  if (!warmupIsOn(c.warmupStatus)) return { verdict: "warmup-off", days };
  if (days === null) return { verdict: "no-start-date", days };
  if (days < rules.minDays) return { verdict: "too-new", days };
  if (rules.skipInCampaign && (c.campaignIds?.length ?? 0) > 0) {
    return { verdict: "in-campaign", days };
  }
  return { verdict: "ready", days };
}

export type VerdictCounts = Record<Verdict, number>;

export function emptyCounts(): VerdictCounts {
  return { ready: 0, "warmup-off": 0, "no-start-date": 0, "too-new": 0, "in-campaign": 0 };
}

export function countVerdicts(verdicts: Verdict[]): VerdictCounts {
  const counts = emptyCounts();
  for (const v of verdicts) counts[v] += 1;
  return counts;
}

/** Why the inboxes that are not ready were left out, most common first. */
export function describeSkipped(counts: VerdictCounts): string {
  const parts = (Object.entries(counts) as [Verdict, number][])
    .filter(([v, n]) => v !== "ready" && n > 0)
    .sort((a, b) => b[1] - a[1]);
  return parts.map(([v, n]) => `${n} ${VERDICT_LABELS[v].toLowerCase()}`).join(", ");
}

// --- By domain ---------------------------------------------------------------
//
// Inboxes are moved a domain at a time: the sheet's warmup date is per domain,
// and a domain's inboxes share a provider and a tenant. So the page lists
// domains, and picking one picks its ready inboxes.

/** What the grouping needs from each judged inbox. */
export interface JudgedInbox {
  email: string;
  domain: string;
  /** Plusvibe's provider key, e.g. GOOGLE_WORKSPACE. */
  provider: string;
  verdict: Verdict;
  days: number | null;
  source: StartSource;
}

export interface DomainSummary {
  domain: string;
  total: number;
  ready: number;
  counts: VerdictCounts;
  /** Inboxes per provider key, most common first. */
  providers: [string, number][];
  /** The longest warmup among its inboxes, and where that date came from. */
  days: number | null;
  source: StartSource;
  /** The ready inboxes' addresses — what a move would take. */
  readyEmails: string[];
}

export function groupByDomain(rows: JudgedInbox[]): DomainSummary[] {
  const map = new Map<string, DomainSummary & { providerCounts: Map<string, number> }>();
  for (const r of rows) {
    const key = normalizeDomain(r.domain) || "(no domain)";
    let g = map.get(key);
    if (!g) {
      g = {
        domain: key,
        total: 0,
        ready: 0,
        counts: emptyCounts(),
        providers: [],
        days: null,
        source: "none",
        readyEmails: [],
        providerCounts: new Map(),
      };
      map.set(key, g);
    }
    g.total += 1;
    g.counts[r.verdict] += 1;
    if (r.verdict === "ready") {
      g.ready += 1;
      g.readyEmails.push(normalizeEmail(r.email));
    }
    g.providerCounts.set(r.provider, (g.providerCounts.get(r.provider) ?? 0) + 1);
    if (r.days !== null && (g.days === null || r.days > g.days)) {
      g.days = r.days;
      g.source = r.source;
    }
  }
  return Array.from(map.values())
    .map(({ providerCounts, ...g }) => ({
      ...g,
      providers: Array.from(providerCounts.entries()).sort((a, b) => b[1] - a[1]),
      readyEmails: [...g.readyEmails].sort(),
    }))
    // Domains with the most to move first; then the ones warmed longest.
    .sort(
      (a, b) =>
        b.ready - a.ready || (b.days ?? -1) - (a.days ?? -1) || a.domain.localeCompare(b.domain)
    );
}

/** The one-word state of a domain, from its inboxes. */
export function domainVerdict(g: DomainSummary): "ready" | "partly" | Verdict {
  if (g.total === 0) return "no-start-date";
  if (g.ready === g.total) return "ready";
  if (g.ready > 0) return "partly";
  // Nothing ready: the most common reason.
  const rest = (Object.entries(g.counts) as [Verdict, number][])
    .filter(([v]) => v !== "ready")
    .sort((a, b) => b[1] - a[1]);
  return rest[0]?.[0] ?? "no-start-date";
}

/**
 * What a selection of domains adds up to. A ticked domain that no longer has
 * a ready inbox — the rules were tightened after it was ticked — counts for
 * nothing, so the total never promises a move that would take no inbox.
 */
export function selectionTotals(
  groups: DomainSummary[],
  selected: Set<string>
): { domains: number; inboxes: number; emails: string[] } {
  let domains = 0;
  const emails: string[] = [];
  for (const g of groups) {
    if (!selected.has(g.domain) || g.ready === 0) continue;
    domains += 1;
    emails.push(...g.readyEmails);
  }
  return { domains, inboxes: emails.length, emails };
}
