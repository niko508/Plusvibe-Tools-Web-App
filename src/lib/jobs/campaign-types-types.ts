// Shared types for Create All Campaign Types jobs (server + client).
//
// The tool takes ONE campaign and produces four:
//
//   Tree Removal (August)              source, untouched copy-wise
//   🔵 Tree Removal (August)           Microsoft leads
//   Tree Removal - Opt Out (August)    opt-out line on step 1
//   🔵 Tree Removal - Opt Out (August) both
//
// Four phases: sort the leads, duplicate the campaigns (and add the opt-out
// copy), move the leads, then launch everything.

export const MAX_STORED_ERRORS = 50;

export type CampaignTypesStatus =
  | "running"
  | "done"
  | "aborted"
  | "interrupted"
  | "error";

/** The four phases the UI shows as steps. */
export type CampaignTypesPhase =
  | "sorting"
  | "duplicating"
  | "moving"
  | "activating"
  | "finished";

export const PHASE_ORDER: Exclude<CampaignTypesPhase, "finished">[] = [
  "sorting",
  "duplicating",
  "moving",
  "activating",
];

export const PHASE_LABELS: Record<CampaignTypesPhase, string> = {
  sorting: "Sorting leads",
  duplicating: "Duplicating campaigns",
  moving: "Moving leads",
  activating: "Activating campaigns",
  finished: "Finished",
};

export type PhaseState = "pending" | "running" | "done" | "skipped" | "error";

/** The four campaigns, by role. */
export type CampaignRole = "source" | "blue" | "optOut" | "blueOptOut";

/** The three roles this tool creates. */
export type CreatedRole = Exclude<CampaignRole, "source">;

export interface CreatedCampaign {
  role: CreatedRole;
  /** The name it is (or will be) created under. */
  name: string;
  /** Set once the campaign exists. */
  campaignId?: string;
  /**
   * True when a campaign with this name already existed and was adopted
   * instead of duplicated — what makes a resumed run safe to repeat.
   */
  reused?: boolean;
  state: PhaseState;
  error?: string;
  /** Opt-out copy, for the two Opt Out roles only. */
  optOut?: {
    state: PhaseState;
    /** Variation labels that got the block on this run. */
    applied: string[];
    /** Labels that already had it. */
    alreadyPresent: string[];
    error?: string;
  };
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
  role: CreatedRole;
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

export interface ActivationTarget {
  role: CampaignRole;
  name: string;
  state: PhaseState;
  error?: string;
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
  sourceCampaignId: string;
  sourceCampaignName: string;

  sorting: SortingProgress;
  created: CreatedCampaign[];
  moving: MovingProgress;
  activation: ActivationTarget[];

  errors: string[];
  errorsTruncated?: boolean;
}

export interface CampaignTypesStartPayload {
  workspaceId: string;
  workspaceName: string;
  sourceCampaignId: string;
  sourceCampaignName: string;
  /** Derived client-side and shown before starting, so sent explicitly. */
  names: { blue: string; optOut: string; blueOptOut: string };
  /** Launch all four at the end. Off leaves the copies as drafts. */
  activate?: boolean;
}
