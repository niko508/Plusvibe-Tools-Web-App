export type Phase = "idle" | "scanning" | "preview";

/** What the pasted list names: whole sending domains, or single mailboxes. */
export type Mode = "domain" | "inbox";

// One inbox found in the scan.
export interface IndexEntry {
  workspace_id: string;
  workspaceName: string;
  email: string;
  /** The inbox's own domain, so a matched entry carries it without re-parsing. */
  domain: string;
  accountId: string;
}

// A pasted domain that matched at least one inbox. In inbox mode this holds
// only the mailboxes that were named, grouped under their domain.
export interface MatchedDomain {
  domain: string;
  inboxes: IndexEntry[];
  workspaces: string[]; // unique workspace names
}

export interface MatchResult {
  matched: MatchedDomain[];
  /** Pasted entries with no inbox behind them: domains, or addresses. */
  notFound: string[];
  /** Pasted addresses that exist but are Master Inboxes, so kept out of reach. */
  protectedMaster: string[];
}

export interface ScanResult {
  mode: Mode;
  matched: MatchedDomain[];
  notFound: string[];
  protectedMaster: string[];
  totalInboxes: number;
  workspaceNames: Record<string, string>;
  excludedMaster: number;
}
