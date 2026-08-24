// Shared types for Create All Campaign Types jobs (server + client).
//
// Plusvibe has no campaign duplicate/create endpoint, so the four campaigns are
// made by hand in the Plusvibe UI first and this tool takes them as input. What
// it automates is the part that doesn't fit in a UI: appending the 621-option
// opt-out spintax to every step-1 variation, and splitting thousands of leads
// across the four campaigns by mailbox provider.

export const MAX_STORED_ERRORS = 50;

export type CampaignTypesStatus =
  | "running"
  | "done"
  | "aborted"
  | "interrupted"
  | "error";

/** The three phases the UI shows as steps. */
export type CampaignTypesPhase =
  | "sorting"
  | "optOutCopy"
  | "moving"
  | "finished";

export const PHASE_ORDER: Exclude<CampaignTypesPhase, "finished">[] = [
  "sorting",
  "optOutCopy",
  "moving",
];

export const PHASE_LABELS: Record<CampaignTypesPhase, string> = {
  sorting: "Sorting leads",
  optOutCopy: "Adding opt-out copy",
  moving: "Moving leads",
  finished: "Finished",
};

export type PhaseState = "pending" | "running" | "done" | "skipped" | "error";

/**
 * The four campaigns, by role.
 *   source      the original — keeps half the non-Microsoft leads
 *   blue        🔵 copy — Microsoft leads
 *   optOut      Opt Out copy — half the non-Microsoft leads, opt-out copy
 *   blueOptOut  🔵 Opt Out copy — Microsoft leads, opt-out copy
 */
export type CampaignRole = "source" | "blue" | "optOut" | "blueOptOut";

export interface RoleCampaign {
  role: CampaignRole;
  campaignId: string;
  name: string;
}

/** Progress of the opt-out spintax write, per Opt Out campaign. */
export interface OptOutTarget {
  role: Extract<CampaignRole, "optOut" | "blueOptOut">;
  name: string;
  state: PhaseState;
  /** Variation labels that received the block on this run. */
  applied: string[];
  /** Labels that already had it — a re-run, so left alone. */
  alreadyPresent: string[];
  error?: string;
}

export interface SortingProgress {
  leadsFound: number;
  microsoft: number;
  other: number;
  domainsTotal: number;
  domainsResolved: number;
  /** Domains whose MX lookup failed; classified as non-Microsoft. */
  unresolvedDomains: number;
  /** Leads classified from a field on the lead rather than DNS. */
  fromLeadField: number;
  /** True if lead collection stopped before the campaign was exhausted. */
  hitPageLimit?: boolean;
}

export interface MoveTarget {
  role: Exclude<CampaignRole, "source">;
  name: string;
  planned: number;
  moved: number;
  state: PhaseState;
}

export interface MovingProgress {
  targets: MoveTarget[];
  /** Leads left in the source campaign by design. */
  staysInSource: number;
  processed: number;
  plannedTotal: number;
}

export interface CampaignTypesJob {
  id: string;
  label: string;
  status: CampaignTypesStatus;
  phase: CampaignTypesPhase;
  phaseStates: Record<Exclude<CampaignTypesPhase, "finished">, PhaseState>;
  createdAt: number;
  updatedAt: number;

  workspaceName: string;
  campaigns: RoleCampaign[];

  sorting: SortingProgress;
  optOut: OptOutTarget[];
  moving: MovingProgress;

  errors: string[];
  errorsTruncated?: boolean;
}

export interface CampaignTypesStartPayload {
  workspaceId: string;
  workspaceName: string;
  campaigns: RoleCampaign[];
  /** Skip phase 2 when the opt-out copy was already added by hand. */
  skipOptOutCopy?: boolean;
}
