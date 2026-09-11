import { normalizeDomainToken } from "@/lib/format";
import type { IndexEntry, MatchedDomain, MatchResult } from "./types";

// Parses a blob of pasted text into a normalized, de-duplicated domain list.
// Handles newlines/commas/semicolons/spaces, full emails, URLs, www., trailing
// dots, and mixed case.
export function parseDomains(raw: string): string[] {
  const set = new Set<string>();
  for (const token of raw.split(/[\s,;]+/)) {
    const t = normalizeDomainToken(token);
    if (t) set.add(t);
  }
  return Array.from(set).sort();
}

// A token is an address only if it has one @ with something either side and a
// dot in the domain. Anything else is a bare domain or junk — reported back so
// the user sees what was ignored rather than silently losing a line.
const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Normalizes one pasted token into a lower-cased address, or null. */
export function normalizeEmailToken(token: string): string | null {
  let t = token.trim().toLowerCase();
  if (!t) return null;
  t = t.replace(/^mailto:/, "");
  // Tolerate a pasted spreadsheet cell: "Name <joe@acme.com>".
  const angled = t.match(/<([^>]+)>/);
  if (angled) t = angled[1].trim();
  t = t.replace(/[,;.]+$/, "");
  return ADDRESS.test(t) ? t : null;
}

/**
 * Parses pasted text into inbox addresses. `skipped` holds the tokens that were
 * not addresses (a bare domain, a header row, a stray word), so the UI can say
 * how many lines it ignored instead of quietly dropping them.
 */
export function parseEmails(raw: string): { emails: string[]; skipped: string[] } {
  const set = new Set<string>();
  const skipped: string[] = [];
  for (const token of raw.split(/[\s,;]+/)) {
    if (!token.trim()) continue;
    const email = normalizeEmailToken(token);
    if (email) set.add(email);
    else skipped.push(token.trim());
  }
  return { emails: Array.from(set).sort(), skipped };
}

/** The domains the pasted addresses live on — what the scan has to cover. */
export function domainsOfEmails(emails: string[]): string[] {
  const set = new Set<string>();
  for (const e of emails) {
    const d = normalizeDomainToken(e);
    if (d) set.add(d);
  }
  return Array.from(set).sort();
}

// Matches pasted domains against the scanned inbox index by exact (case-
// insensitive) domain equality.
export function matchDomains(
  parsed: string[],
  index: Map<string, IndexEntry[]>
): MatchResult {
  const matched: MatchedDomain[] = [];
  const notFound: string[] = [];

  for (const domain of parsed) {
    const inboxes = index.get(domain);
    if (!inboxes || inboxes.length === 0) {
      notFound.push(domain);
      continue;
    }
    const workspaces = Array.from(
      new Set(inboxes.map((i) => i.workspaceName))
    ).sort();
    matched.push({ domain, inboxes: [...inboxes], workspaces });
  }

  return { matched, notFound, protectedMaster: [] };
}

/**
 * Matches pasted addresses against the scanned index, one mailbox at a time.
 * The result is still grouped by domain so the preview and the job's per-domain
 * rollup read the same in both modes — but only the named inboxes are in it.
 *
 * An address that belongs to a "Master Inbox" comes back under
 * `protectedMaster` rather than `notFound`: it exists, it was deliberately kept
 * out of reach, and saying "not found" would send the user hunting for it.
 */
export function matchEmails(
  emails: string[],
  index: Map<string, IndexEntry[]>,
  masterEmails: Set<string>
): MatchResult {
  const byDomain = new Map<string, IndexEntry[]>();
  const notFound: string[] = [];
  const protectedMaster: string[] = [];

  for (const raw of emails) {
    // Lower-cased here as well as in the parser: an address is a case-
    // insensitive thing to look up whoever hands it over.
    const email = raw.trim().toLowerCase();
    const domain = normalizeDomainToken(email);
    const entry = domain
      ? index.get(domain)?.find((i) => i.email.trim().toLowerCase() === email)
      : undefined;
    if (!entry) {
      if (masterEmails.has(email)) protectedMaster.push(email);
      else notFound.push(email);
      continue;
    }
    const arr = byDomain.get(entry.domain);
    if (arr) arr.push(entry);
    else byDomain.set(entry.domain, [entry]);
  }

  const matched: MatchedDomain[] = Array.from(byDomain.entries())
    .map(([domain, inboxes]) => ({
      domain,
      inboxes,
      workspaces: Array.from(new Set(inboxes.map((i) => i.workspaceName))).sort(),
    }))
    .sort((a, b) => a.domain.localeCompare(b.domain));

  return { matched, notFound, protectedMaster };
}
