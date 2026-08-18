// Shared types for "Move Leads to Another Campaign" background jobs. Used by
// the client tool, the API routes and the server-side manager — so NO
// server-only imports here.

export type MoveJobStatus =
  | "running"
  | "done"
  | "aborted"
  | "interrupted"
  | "error";

export type MovePhase = "collecting" | "moving" | "finished";

export interface MoveProgress {
  /** How many leads the run was asked to move. */
  requested: number;
  /** How many not-contacted leads were actually found in the source. */
  found: number;
  /** Leads handled so far (added + confirmed already there). */
  processed: number;
  added: number;
  alreadyInDestination: number;
  deletedFromSource: number;
}

/** One source → destination move. Each pair runs as its own job. */
export interface MoveLeadsJob {
  id: string;
  label: string;
  status: MoveJobStatus;
  createdAt: number;
  updatedAt: number;
  workspaceName: string;
  sourceName: string;
  destinationName: string;
  phase: MovePhase;
  progress: MoveProgress;
  errors: string[];
}

export interface MovePair {
  sourceCampaignId: string;
  sourceName: string;
  destinationCampaignId: string;
  destinationName: string;
  count: number;
}

export interface MoveLeadsStartPayload {
  workspaceId: string;
  workspaceName: string;
  pairs: MovePair[];
}

/** Plusvibe's rate budget is shared, so more than a few at once just queues. */
export const MAX_PAIRS = 3;
export const MAX_PER_PAIR = 5000;
export const MAX_STORED_ERRORS = 100;
