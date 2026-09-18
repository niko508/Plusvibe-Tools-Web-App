// Shared types for Create All Campaign Types jobs (server + client).
//
// A run takes SEVERAL original campaigns from one workspace and, for each,
// produces up to six:
//
//   🟡 Tree Removal (August)                source, untouched copy-wise
//   🔵 Tree Removal (August)                Microsoft leads           (Default)
//   🟡 Tree Removal - Opt Out (August)      opt-out line on step 1    (With Opt Out)
//   🔵 Tree Removal - Opt Out (August)      both
//   🟡 Tree Removal - Signature (August)    step 1 signs off with the signature (With Signature)
//   🔵 Tree Removal - Signature (August)    both
//
// Three phases:
//   1 segmenting  every original's leads are sorted by their Segment field
//                 into the original that segment names
//   2 building    each original in turn: sort its leads by mailbox provider,
//                 duplicate the copies asked for, move the leads into them,
//                 launch everything
//   3 tagging     every plain campaign is tagged google-pool, every 🔵 one
//                 microsoft-pool

import type { SegmentRule } from "@/lib/campaign-types/segments";

export const MAX_STORED_ERRORS = 50;

/**
 * The campaign types a run can build. Defined here rather than in
 * campaign-types/kinds.ts, which imports CREATED_ROLES from this file: the
 * dependency has to run one way.
 */
export type CampaignKind = "default" | "optOut" | "signature";

/**
 * What a run does.
 *
 * "create" is the whole thing. "move" finds the copies by name instead of
 * making them — they were built by an earlier run — and launches nothing;
 * the segment sort, the provider split and the pool tags happen either way.
 */
export type CampaignTypesMode = "create" | "move";

export type CampaignTypesStatus =
  /** Accepted and waiting its turn — nothing has been created for it yet. */
  | "queued"
  | "running"
  | "done"
  | "aborted"
  | "interrupted"
  | "error";

/** The three phases the card shows as steps. */
export type JobPhase = "segmenting" | "building" | "tagging" | "finished";

export const JOB_PHASE_ORDER: Exclude<JobPhase, "finished">[] = ["segmenting", "building", "tagging"];

export function jobPhaseLabel(phase: Exclude<JobPhase, "finished">, mode: CampaignTypesMode | undefined): string {
  if (phase === "segmenting") return "Sorting by segment";
  if (phase === "tagging") return "Tagging the pools";
  return mode === "move" ? "Moving leads" : "Building campaigns";
}

/** The four steps each original goes through inside the building phase. */
export type CampaignTypesPhase = "sorting" | "duplicating" | "moving" | "activating" | "finished";

export const PHASE_ORDER: Exclude<CampaignTypesPhase, "finished">[] = ["sorting", "duplicating", "moving", "activating"];

export const PHASE_LABELS: Record<CampaignTypesPhase, string> = {
  sorting: "Sorting leads",
  duplicating: "Duplicating campaigns",
  moving: "Moving leads",
  activating: "Activating campaigns",
  finished: "Finished",
};

/** A move run finds its campaigns rather than making them. */
export const MOVE_PHASE_LABELS: Record<CampaignTypesPhase, string> = {
  ...PHASE_LABELS,
  duplicating: "Finding campaigns",
};

export function phaseLabel(phase: CampaignTypesPhase, mode: CampaignTypesMode | undefined): string {
  return (mode === "move" ? MOVE_PHASE_LABELS : PHASE_LABELS)[phase];
}

export type PhaseState = "pending" | "running" | "done" | "skipped" | "error";

/** The six campaigns, by role. */
export type CampaignRole = "source" | "blue" | "optOut" | "blueOptOut" | "signature" | "blueSignature";

/** The five roles this tool can create. */
export type CreatedRole = Exclude<CampaignRole, "source">;

/**
 * Creation order. "blue" leads because the two 🔵 copies duplicate from it
 * rather than from the source, so it has to exist first.
 */
export const CREATED_ROLES: CreatedRole[] = ["blue", "optOut", "blueOptOut", "signature", "blueSignature"];

/** Roles whose step 1 gets the opt-out spintax appended. */
export const OPT_OUT_ROLES: CreatedRole[] = ["optOut", "blueOptOut"];

/** Roles whose step 1 signs off with {{sender_signature}}. */
export const SIGNATURE_ROLES: CreatedRole[] = ["signature", "blueSignature"];

/** The 🔵 copies, duplicated from the blue campaign when there is one. */
export const FROM_BLUE_ROLES: CreatedRole[] = ["blueOptOut", "blueSignature"];

export type RoleNames = Record<CreatedRole, string>;

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
  /** Google recipients. Absent on the oldest records, where `other` was everything not Microsoft. */
  google?: number;
  /** Neither Microsoft nor Google; they go to the 🔵 campaigns. */
  other: number;
  domainsTotal: number;
  domainsResolved: number;
  /** Domains whose MX lookup failed; classified as neither. */
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

/** One original campaign and everything built from it. */
export interface SourceRun {
  campaignId: string;
  campaignName: string;
  state: PhaseState;
  phase: CampaignTypesPhase;
  phaseStates: Record<Exclude<CampaignTypesPhase, "finished">, PhaseState>;
  sorting: SortingProgress;
  created: CreatedCampaign[];
  moving: MovingProgress;
  activation: ActivationTarget[];
}

export interface SegmentRuleProgress {
  segment: string | null;
  campaignId: string;
  campaignName: string;
  planned: number;
  moved: number;
  unmoved?: number;
  state: PhaseState;
}

export interface SegmentingProgress {
  rules: SegmentRuleProgress[];
  leadsFound: number;
  /** Already in the campaign their segment names. */
  stayed: number;
  /** A segment no rule covers; left where they were. */
  unmapped: number;
  unmappedSegments: string[];
  plannedTotal: number;
  processed: number;
  moved: number;
  unmoved?: number;
  unmovedReasons?: Record<string, number>;
}

export interface TagTarget {
  campaignId: string;
  name: string;
  /** "google-pool" or "microsoft-pool". */
  tag: string;
  state: PhaseState;
  error?: string;
}

export interface TaggingProgress {
  targets: TagTarget[];
  /** Pool tags this run had to create in the workspace. */
  tagsCreated: string[];
}

export interface CampaignTypesJob {
  id: string;
  label: string;
  /** Absent on records written before Move Leads existed, i.e. "create". */
  mode?: CampaignTypesMode;
  status: CampaignTypesStatus;
  phase: JobPhase;
  phaseStates: Record<Exclude<JobPhase, "finished">, PhaseState>;
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

  /** The campaign types this run builds. */
  kinds: CampaignKind[];

  segmenting: SegmentingProgress;
  sources: SourceRun[];
  tagging: TaggingProgress;

  errors: string[];
  errorsTruncated?: boolean;
}

export interface SourceInput {
  campaignId: string;
  campaignName: string;
  /** Derived client-side and shown before starting, so sent explicitly. */
  names: RoleNames;
}

export interface CampaignTypesStartPayload {
  /** Defaults to "create". */
  mode?: CampaignTypesMode;
  workspaceId: string;
  workspaceName: string;
  sources: SourceInput[];
  kinds: CampaignKind[];
  rules: SegmentRule[];
  /** Launch everything at the end. Off leaves the copies as drafts. */
  activate?: boolean;
}
