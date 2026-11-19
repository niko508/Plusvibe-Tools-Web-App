// Shared types for Clone Campaign with Winning Variants jobs (server + client).
//
// A run takes the segments ticked in one workspace and, for each, reads every
// campaign of the segment, keeps step 1's variants that got a positive reply
// (follow-up positives credited to the first email), and duplicates the
// segment's base campaign as a 🟡 clone with only those variants in step 1.
// It runs on the server, one segment after another, so the page can be closed.

import type { OptOutChoice } from "@/lib/winning-variants/plan";

export const MAX_STORED_ERRORS = 50;
/** Most segments in one run. */
export const MAX_SEGMENTS = 60;

export interface SegmentInput {
  segment: string;
  /** The campaign cloned: settings, follow-ups and sub-sequences come from it. */
  baseId: string;
  baseName: string;
  /** Every campaign of the segment whose step-1 winners count, the base included. */
  ids: string[];
  /** The clone's name. */
  name: string;
}

export interface WinningVariantsStartPayload {
  workspaceId: string;
  workspaceName: string;
  segments: SegmentInput[];
  /** Tags the clones carry, by id. */
  tagIds: string[];
  /** Tags to create first and put on every clone, by name. */
  newTags: string[];
  /** The opt-out line on the kept variants: added, taken out, or left as each has it. */
  optOut: OptOutChoice;
}

export type SegmentState = "pending" | "running" | "done" | "skipped" | "error";

export interface WinnerSummary {
  /** Its letter in the clone. */
  variation: string;
  /** The campaign it came from. */
  campaignName?: string;
  sent: number;
  replies: number;
  positiveReplies: number;
}

export interface SegmentOutcome extends SegmentInput {
  state: SegmentState;
  /** Why it was skipped or what went wrong. */
  note?: string;
  createdId?: string;
  /** Step-1 variants kept in the clone. */
  kept?: number;
  /** Step-1 variants read across the segment's campaigns. */
  of?: number;
  /** The strongest kept variants, most positive replies first. */
  top?: WinnerSummary[];
  /** Positive replies to follow-ups credited to the first email. */
  credited?: number;
  verified?: boolean;
  problems?: string[];
  warnings?: string[];
  startedAt?: number;
  finishedAt?: number;
}

export type WinningVariantsStatus = "running" | "done" | "aborted" | "interrupted" | "error";

export interface WinningVariantsJob {
  id: string;
  status: WinningVariantsStatus;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  workspaceId: string;
  workspaceName: string;
  optOut: OptOutChoice;
  /** The tags every clone gets, by name, for the card. */
  tagNames: string[];
  segments: SegmentOutcome[];
  errors: string[];
  /** Set when a restart cut the run off and it could not be picked up with the server's key. */
  resumeBlocked?: string;
}
