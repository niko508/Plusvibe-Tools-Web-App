// Shared types for "New Workspace 1st Campaign" jobs (server + client).
//
// Three phases, in order:
//
//   1 labels        make sure the seven custom lead labels exist, and collect
//                   their keys (a new workspace has none of them)
//   2 parent        create the campaign shell, then PATCH in step 1, the
//                   schedule, the "Active" tag and every setting
//   3 subsequences  create the six sub-sequences with their label triggers,
//                   then PATCH each one's schedule

export const MAX_STORED_ERRORS = 50;

export type FirstCampaignStatus =
  | "running"
  | "done"
  | "aborted"
  | "interrupted"
  | "error";

export type FirstCampaignPhase =
  | "labels"
  | "parent"
  | "subsequences"
  | "finished";

export const PHASE_ORDER: Exclude<FirstCampaignPhase, "finished">[] = [
  "labels",
  "parent",
  "subsequences",
];

export const PHASE_LABELS: Record<FirstCampaignPhase, string> = {
  labels: "Preparing lead labels",
  parent: "Creating parent campaign",
  subsequences: "Creating sub-sequences",
  finished: "Finished",
};

export type PhaseState = "pending" | "running" | "done" | "skipped" | "error";

/** One of the blueprint's lead labels, as the run resolved it. */
export interface LabelProgress {
  name: string;
  state: PhaseState;
  /** The stable key, once known — read from the API, never derived. */
  key?: string;
  /** True when the workspace already had it and it was reused. */
  reused?: boolean;
  error?: string;
}

/** The steps that turn an empty campaign shell into the real thing. */
export interface ParentProgress {
  name: string;
  campaignId?: string;
  /** True when a campaign of this name already existed and was adopted. */
  reused?: boolean;
  createState: PhaseState;
  settingsState: PhaseState;
  /** Tag whose accounts send the campaign; null when it wasn't found. */
  tagName: string;
  tagId?: string;
  tagMissing?: boolean;
  /** Which `schedules` shape the API accepted, once known. */
  scheduleForm?: "object" | "array";
  error?: string;
}

export interface SubsequenceProgress {
  name: string;
  /** Display names of the labels that trigger it. */
  labelNames: string[];
  campaignId?: string;
  reused?: boolean;
  createState: PhaseState;
  /** Schedule, emails and the delay before the first one. */
  settingsState: PhaseState;
  /** How many email steps were written; 0 when the copy isn't written yet. */
  steps: number;
  /** Days from the trigger firing to step 1, when there are steps. */
  firstWaitDays?: number;
  error?: string;
}

export interface FirstCampaignJob {
  id: string;
  label: string;
  status: FirstCampaignStatus;
  phase: FirstCampaignPhase;
  phaseStates: Record<Exclude<FirstCampaignPhase, "finished">, PhaseState>;
  createdAt: number;
  updatedAt: number;

  workspaceName: string;

  labels: LabelProgress[];
  parent: ParentProgress;
  subsequences: SubsequenceProgress[];

  /**
   * Settings the campaign screen has but the API cannot set, so the run can say
   * plainly what still needs a manual touch rather than implying it's done.
   */
  manualFollowUps: string[];

  errors: string[];
  errorsTruncated?: boolean;
}

export interface FirstCampaignStartPayload {
  workspaceId: string;
  workspaceName: string;
  campaignName: string;
}
