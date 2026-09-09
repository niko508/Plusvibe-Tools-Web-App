// Shared types for Create All Campaign Types jobs (server + client).
//
// The tool takes ONE campaign and produces six:
//
//   Tree Removal (August)                source, untouched copy-wise
//   🔵 Tree Removal (August)             Microsoft leads
//   Tree Removal - Opt Out (August)      opt-out line on step 1
//   🔵 Tree Removal - Opt Out (August)   both
//   Tree Removal - Signature (August)    step 1 signs off with the signature
//   🔵 Tree Removal - Signature (August) both
//
// Four phases: sort the leads, duplicate the campaigns (adding the opt-out copy
// and swapping the sign-off), move the leads, then launch everything.

export const MAX_STORED_ERRORS = 50;

export type CampaignTypesStatus =
  /** Accepted and waiting its turn — nothing has been created for it yet. */
  | "queued"
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

/** The six campaigns, by role. */
export type CampaignRole =
  | "source"
  | "blue"
  | "optOut"
  | "blueOptOut"
  | "signature"
  | "blueSignature";

/** The five roles this tool creates. */
export type CreatedRole = Exclude<CampaignRole, "source">;

/**
 * Creation order. "blue" leads because the two 🔵 copies duplicate from it
 * rather than from the source, so it has to exist first.
 */
export const CREATED_ROLES: CreatedRole[] = [
  "blue",
  "optOut",
  "blueOptOut",
  "signature",
  "blueSignature",
];

/** Roles whose step 1 gets the opt-out spintax appended. */
export const OPT_OUT_ROLES: CreatedRole[] = ["optOut", "blueOptOut"];

/** Roles whose step 1 signs off with {{sender_signature}}. */
export const SIGNATURE_ROLES: CreatedRole[] = ["signature", "blueSignature"];

/** The 🔵 copies, duplicated from the blue campaign rather than the source. */
export const FROM_BLUE_ROLES: CreatedRole[] = ["blueOptOut", "blueSignature"];

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
  /** Sign-off swap, for the two Signature roles only. */
  signature?: {
    state: PhaseState;
    /** Variation labels swapped to {{sender_signature}} on this run. */
    applied: string[];
    /** Labels already signing off with it. */
    alreadyPresent: string[];
    /** Labels carrying neither variable, so nothing was swapped. */
    missing: string[];
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
  /** Planned for this campaign but left in the source: refused, or unconfirmed. */
  unmoved?: number;
  state: PhaseState;
}

export interface MovingProgress {
  targets: MoveTarget[];
  /** Leads left in the source campaign by design. */
  staysInSource: number;
  processed: number;
  plannedTotal: number;
  /** Leads that stayed in the source when they should have moved. */
  unmoved?: number;
  /** Why, by reason, e.g. { duplicate: 2, "invalid-email": 1 }. */
  unmovedReasons?: Record<string, number>;
  /** Plusvibe's lead quota was reached mid-split; the rest was skipped. */
  quotaHit?: boolean;
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
  /** When the job left the queue and actually began. Unset while queued. */
  startedAt?: number;
  /**
   * 1 = next to run. Set only while queued, and computed per request rather
   * than stored — it changes as the jobs ahead finish.
   */
  queuePosition?: number;

  workspaceId?: string;
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
  names: {
    blue: string;
    optOut: string;
    blueOptOut: string;
    signature: string;
    blueSignature: string;
  };
  /** Launch all six at the end. Off leaves the copies as drafts. */
  activate?: boolean;
}
