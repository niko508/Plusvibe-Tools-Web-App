export type Phase = "idle" | "scanning" | "preview";

// One inbox found in the scan.
export interface IndexEntry {
  workspace_id: string;
  workspaceName: string;
  email: string;
  accountId: string;
}

// A pasted domain that matched at least one inbox.
export interface MatchedDomain {
  domain: string;
  inboxes: IndexEntry[];
  workspaces: string[]; // unique workspace names
}

export interface ScanResult {
  matched: MatchedDomain[];
  notFound: string[];
  totalInboxes: number;
  workspaceNames: Record<string, string>;
  excludedMaster: number;
}
