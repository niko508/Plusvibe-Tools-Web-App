// Shared types for Start Outreach jobs (client + API routes + job manager).
// No server-only imports here.

import type { SignatureFields } from "@/app/tools/add-signatures/types";
import type { TagInput } from "@/lib/tags/bulk-tags";
import type {
  MovingInbox,
  OutreachSettingsInput,
  SettingsRow,
} from "@/lib/start-outreach/plan";
import type { Category } from "@/lib/start-outreach/categories";

export type StartOutreachStatus = "running" | "done" | "aborted" | "interrupted" | "error";

export type StepKey = "move" | "verify" | "settings" | "signatures" | "tags" | "sheet";

export type StepState = "pending" | "running" | "done" | "partial" | "error" | "skipped";

export const STEP_LABELS: Record<StepKey, string> = {
  move: "Move to the client workspace",
  verify: "Check they arrived",
  settings: "Apply the settings",
  signatures: "Set the signatures",
  tags: "Add the tags",
  sheet: "Update the sheet",
};

export interface StepRecord {
  key: StepKey;
  state: StepState;
  /** Units done and the total, in whatever the step counts (inboxes, cells). */
  done: number;
  total: number;
  /** What happened, in a line. */
  note?: string;
  error?: string;
}

export interface StartOutreachJob {
  id: string;
  label: string;
  status: StartOutreachStatus;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  source: { id: string; name: string };
  destination: { id: string; name: string };
  inboxes: number;
  domains: number;
  steps: StepRecord[];
  /** Week 1 as it was applied, per category present in the batch. */
  settings: SettingsRow[];
  categories: JobCategory[];
  /** The week 2 switch this run booked, when it booked one. */
  scheduledSwitchId?: string;
  scheduledFor?: number;
  signatures: boolean;
  activeTag: string | null;
  domainTags: boolean;
  sheet: boolean;
  /** Inboxes that were not found in the destination after the move. */
  notMoved: string[];
  errors: string[];
  errorsTruncated?: boolean;
}

/** What a run did to one category of the batch. */
export interface JobCategory {
  category: Category;
  inboxes: number;
  /** The week 1 rows applied to it, for the card. */
  week1: SettingsRow[];
  /** Whether week 2 has anything to change. */
  week2Scheduled: boolean;
}

export interface StartOutreachStartPayload {
  sourceWorkspaceId: string;
  sourceWorkspaceName: string;
  destWorkspaceId: string;
  destWorkspaceName: string;
  inboxes: MovingInbox[];
  /**
   * Week 1 and week 2 for each category in this batch.
   *
   * Week 1 is applied by the run; week 2 is stored on a scheduled switch and
   * applied seven days later. A category that isn't here gets nothing, which
   * is how an uncategorised domain is left alone rather than guessed at.
   */
  weeks: Partial<Record<Category, { week1: OutreachSettingsInput; week2: OutreachSettingsInput }>>;
  /** Null skips the signature step. */
  signatures: SignatureFields | null;
  /** Null skips the tag; otherwise the tag's name. */
  activeTag: string | null;
  /** Null skips the TLD / platform tags. */
  domainTags: { tld: TagInput[]; platform: TagInput[] } | null;
  sheet: { url?: string; tab?: string; updateClient: boolean };
}

export const MAX_STORED_ERRORS = 200;
/** Account ids per move / bulk-update / tag-assign call. */
export const CHUNK = 100;
