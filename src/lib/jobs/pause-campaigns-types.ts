// Shared types for Pause Campaigns jobs (server + client).
//
// A job pauses every ACTIVE campaign — parents and sub-sequences alike — in
// each chosen workspace, and can carry a date on which it turns exactly those
// campaigns back on. "Exactly those" is the whole design: the job remembers
// what it paused, so the resume never touches a campaign someone paused by
// hand, and never has to guess.

export const MAX_STORED_ERRORS = 50;

export type PauseCampaignsStatus =
  /** Pausing is in progress. */
  | "running"
  /** Pausing finished and a resume is scheduled — waiting for the date. */
  | "paused"
  /** The scheduled (or manual) resume is in progress. */
  | "resuming"
  /** Finished: paused with no resume scheduled, or resumed. */
  | "done"
  | "aborted"
  | "interrupted"
  | "error";

export type PhaseState = "pending" | "running" | "done" | "skipped" | "error";

export type CampaignKind = "parent" | "subseq";

/** One campaign the job paused, and later what happened when it resumed. */
export interface PausedCampaign {
  id: string;
  name: string;
  kind: CampaignKind;
  /** For a sub-sequence, the parent it belongs to. */
  parentId?: string;
  pausedAt: number;
  /** Set once the resume for this campaign succeeded. */
  resumedAt?: number;
  resumeError?: string;
}

export interface WorkspaceOutcome {
  workspaceId: string;
  workspaceName: string;
  state: PhaseState;
  /** Campaigns seen in the workspace, all statuses. */
  scanned: number;
  /** Of those, how many were not ACTIVE and so left alone. */
  skipped: number;
  /** Individual campaigns that failed to pause (name → reason). */
  pauseErrors: { id: string; name: string; reason: string }[];
  campaigns: PausedCampaign[];
  /** A failure that stopped this workspace before any pausing (e.g. listing). */
  error?: string;
}

export interface PauseCampaignsJob {
  id: string;
  label: string;
  status: PauseCampaignsStatus;
  createdAt: number;
  updatedAt: number;

  workspaces: WorkspaceOutcome[];

  /** Epoch ms at which the paused campaigns are turned back on. */
  resumeAt?: number;
  /** Set once a resume pass has run to completion. */
  resumedAt?: number;
  resumeTrigger?: "scheduled" | "manual";
  /** Where the key for the resume came from — worth knowing after a restart. */
  resumeKeySource?: "memory" | "server" | "browser";
  /**
   * The resume was due but couldn't run: after a restart the key that paused
   * the campaigns is gone and no server key is set. Cleared when it runs.
   */
  resumeBlocked?: "no-key";

  errors: string[];
  errorsTruncated?: boolean;
}

export interface PauseCampaignsStartPayload {
  workspaces: { id: string; name: string }[];
  /** Epoch ms. Omit to pause with no scheduled resume. */
  resumeAt?: number;
}

/** What a dry run reports for one workspace, before anything is paused. */
export interface PausePlanWorkspace {
  workspaceId: string;
  workspaceName: string;
  scanned: number;
  parents: number;
  subsequences: number;
  skipped: number;
  /** Another job already holds a scheduled resume for this workspace. */
  pendingResumeAt?: number;
  error?: string;
}

export interface PausePlan {
  workspaces: PausePlanWorkspace[];
  totals: { parents: number; subsequences: number; skipped: number; errors: number };
}

export interface PauseCampaignsView {
  jobs: PauseCampaignsJob[];
  readiness: {
    /** PLUSVIBE_API_KEY is set, so a scheduled resume survives a restart. */
    serverKey: boolean;
  };
}
