// Shared types for the scheduled week 2 switch (client + API + scheduler).
// No server-only imports here.

import type { Category } from "@/lib/start-outreach/categories";
import type { OutreachSettingsInput } from "@/lib/start-outreach/plan";

export type SwitchStatus =
  /** Waiting for its morning. */
  | "scheduled"
  /** Being applied right now. */
  | "running"
  /** Applied. */
  | "done"
  /** Applied, but not to everything. */
  | "error"
  /** Called off before it ran. */
  | "cancelled";

export interface SwitchCategory {
  category: Category;
  /**
   * The addresses to switch, not Plusvibe ids.
   *
   * A week is long enough for an inbox to be deleted, moved or re-created, so
   * the ids are looked up again in the workspace on the morning it runs —
   * a stale id would silently change the settings of whatever now holds it.
   */
  emails: string[];
  /** What week 2 says for this category, as it was when the batch ran. */
  settings: OutreachSettingsInput;
  /** Filled in once it has run. */
  updated?: number;
  notFound?: number;
}

export interface ScheduledSwitch {
  id: string;
  status: SwitchStatus;
  createdAt: number;
  /** Six in the morning Helsinki time, seven days after the batch started. */
  dueAt: number;
  ranAt?: number;

  /** The run this came from, and where its inboxes now live. */
  jobId: string;
  workspaceId: string;
  workspaceName: string;

  categories: SwitchCategory[];
  totalInboxes: number;

  errors: string[];
}

export const MAX_STORED_ERRORS = 50;
