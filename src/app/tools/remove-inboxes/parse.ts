import { normalizeDomainToken } from "@/lib/format";
import type { IndexEntry, MatchedDomain } from "./types";

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

// Matches pasted domains against the scanned inbox index. Exact domain equality
// by default; when includeSubdomains is on, also matches any indexed domain
// that is a subdomain of a pasted one (e.g. "mail.acme.com" for "acme.com").
export function matchDomains(
  parsed: string[],
  index: Map<string, IndexEntry[]>,
  includeSubdomains: boolean
): { matched: MatchedDomain[]; notFound: string[] } {
  const matched: MatchedDomain[] = [];
  const notFound: string[] = [];

  for (const domain of parsed) {
    let inboxes = index.get(domain) ? [...index.get(domain)!] : [];
    if (includeSubdomains) {
      const suffix = "." + domain;
      for (const [key, entries] of index) {
        if (key !== domain && key.endsWith(suffix)) inboxes.push(...entries);
      }
    }
    if (inboxes.length === 0) {
      notFound.push(domain);
      continue;
    }
    const workspaces = Array.from(
      new Set(inboxes.map((i) => i.workspaceName))
    ).sort();
    matched.push({ domain, inboxes, workspaces });
  }

  return { matched, notFound };
}
