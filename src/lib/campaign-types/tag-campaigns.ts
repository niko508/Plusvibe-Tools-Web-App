import "server-only";

import { acquireSlot } from "@/lib/jobs/rate-limit";
import { plusvibePut } from "@/lib/plusvibe-server";
import { listTags } from "@/lib/plusvibe-tags";
import { resolveTag } from "@/lib/inbox-tags/api";
import { POOL_TAGS, type Pool } from "./pools";

// Tagging campaigns with their pool.
//
//   PUT /campaign/bulk-assign-tags  { workspace_id, ids, tag_id, action: "ASSIGN" }
//
// The campaign counterpart of the inbox call, same shape. Additive: whatever
// tags a campaign already carries stay. The two pool tags are found in the
// workspace by name and created when missing, the way the inbox-tag jobs do.

/** The ids of both pool tags in this workspace, creating what is missing. */
export async function resolvePoolTags(
  apiKey: string,
  workspaceId: string
): Promise<{ ids: Record<Pool, string>; created: string[] }> {
  await acquireSlot();
  const existing = await listTags(apiKey, workspaceId);
  const created: string[] = [];
  const ids = {} as Record<Pool, string>;
  for (const pool of ["google", "microsoft"] as Pool[]) {
    const tag = POOL_TAGS[pool];
    const r = await resolveTag(apiKey, workspaceId, existing, tag.name, tag.color);
    ids[pool] = r.id;
    if (r.created) created.push(tag.name);
  }
  return { ids, created };
}

/** Adds one tag to these campaigns. */
export async function assignCampaignTag(
  apiKey: string,
  workspaceId: string,
  campaignIds: string[],
  tagId: string
): Promise<void> {
  if (campaignIds.length === 0) return;
  await acquireSlot();
  await plusvibePut({
    apiKey,
    path: "/campaign/bulk-assign-tags",
    body: { workspace_id: workspaceId, ids: campaignIds, tag_id: tagId, action: "ASSIGN" },
  });
}
