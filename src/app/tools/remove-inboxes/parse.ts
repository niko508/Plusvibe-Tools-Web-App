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

// Matches pasted domains against the scanned inbox index by exact (case-
// insensitive) domain equality.
export function matchDomains(
  parsed: string[],
  index: Map<string, IndexEntry[]>
): { matched: MatchedDomain[]; notFound: string[] } {
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

  return { matched, notFound };
}
