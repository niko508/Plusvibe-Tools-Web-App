// Shared types for Start Outreach jobs (client + API routes + job manager).
// No server-only imports here.

import type { SignatureFields } from "@/app/tools/add-signatures/types";
import type { TagInput } from "@/lib/tags/bulk-tags";
import type {
  MovingInbox,
  OutreachSettingsInput,
  SettingsRow,
} from "@/lib/start-outreach/plan";

export type StartOutreachStatus = "running" | "done" | "aborted" | "interrupted" | "error";

export type StepKey = "move" | "verify" | "settings" | "signatures" | "tags" | "sheet";

export type StepState = "pending" | "running" | "done" | "partial" | "error" | "skipped";

export const STEP_LABELS: Record<StepKey, string> = {
  move: "Move to the client workspace",
  verify: "Check they arrived",
  settings: "Apply the settings",
  signatures: "Set the signatures",
  tags: "Add the tags",
  sheet: "Update the sheet's Client column",
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
  settings: SettingsRow[];
  signatures: boolean;
  activeTag: string | null;
  domainTags: boolean;
  sheet: boolean;
  /** Inboxes that were not found in the destination after the move. */
  notMoved: string[];
  errors: string[];
  errorsTruncated?: boolean;
}

export interface StartOutreachStartPayload {
  sourceWorkspaceId: string;
  sourceWorkspaceName: string;
  destWorkspaceId: string;
  destWorkspaceName: string;
  inboxes: MovingInbox[];
  settings: OutreachSettingsInput;
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
