// Which campaigns Change Email Copy Sections will edit, by status.
//
// The copy of an active or paused campaign is the copy going out, and a draft
// is the copy about to: all three are worth editing, and a draft is the safest
// of them since nothing has been sent from it yet.
//
// Completed and archived campaigns are left out. Their copy is a record of
// what was sent rather than something to change, Plusvibe hides archived ones
// from its own lists, and the write is wholesale with no undo — so quietly
// rewriting the history of a finished campaign is the kind of surprise this
// tool must not produce.
//
// Shared by the picker and the background job so the two cannot disagree about
// what is in scope. Pure module — no API — so all of it is unit-tested.

export type CampaignBucket = "active" | "draft" | "paused" | "completed" | "archived";

/**
 * Plusvibe's status string as a bucket.
 *
 * Anything unrecognised reads as a draft, which is what an unlaunched campaign
 * comes back as ("DRAFTED"), and what a status this build has never seen is
 * most likely to be.
 */
export function statusBucket(status: string | undefined | null): CampaignBucket {
  const s = String(status ?? "").trim().toUpperCase();
  if (s === "ACTIVE" || s === "RUNNING") return "active";
  if (s === "PAUSED") return "paused";
  if (s === "COMPLETED") return "completed";
  if (s === "ARCHIVED") return "archived";
  return "draft";
}

export const BUCKET_LABEL: Record<CampaignBucket, string> = {
  active: "Active",
  draft: "Draft",
  paused: "Paused",
  completed: "Completed",
  archived: "Archived",
};

/** The buckets this tool edits, in the order the picker lists them. */
export const EDITABLE_BUCKETS: CampaignBucket[] = ["active", "paused", "draft"];

export function isEditableStatus(status: string | undefined | null): boolean {
  return EDITABLE_BUCKETS.includes(statusBucket(status));
}

/** "Active, paused and draft campaigns only" — the rule, in words. */
export const EDITABLE_SUMMARY = "Active, paused and draft campaigns only";
/** What is left out, for the count beside it. */
export const EXCLUDED_SUMMARY = "completed or archived not shown";
