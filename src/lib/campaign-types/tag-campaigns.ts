import "server-only";

import { acquireSlot } from "@/lib/jobs/rate-limit";
import { plusvibePut } from "@/lib/plusvibe-server";
import { listTags } from "@/lib/plusvibe-tags";
import { listCampaignsRaw } from "@/lib/plusvibe-campaigns";
import { resolveTag } from "@/lib/inbox-tags/api";
import { POOL_TAGS, type Pool } from "./pools";

// Tagging campaigns with their pool.
//
//   PUT /campaign/bulk-assign-tags  { workspace_id, ids, tag_id, action: "ASSIGN" | "UNASSIGN" }
//
// The campaign counterpart of the inbox call, same shape. Assigning is
// additive: whatever tags a campaign already carries stay — which is the
// catch. Duplicating a campaign copies its tags, so a 🔵 copy made from an
// original that is already google-pool arrives carrying google-pool. So the
// other pool's tag is taken OFF the campaigns found carrying it, and only
// those: the listing says which.
//
// The two pool tags are found in the workspace by name and created when
// missing, the way the inbox-tag jobs do.

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
export async function assignCampaignTag(apiKey: string, workspaceId: string, campaignIds: string[], tagId: string): Promise<void> {
  await bulkTag(apiKey, workspaceId, campaignIds, tagId, "ASSIGN");
}

/** Takes one tag off these campaigns. Nothing else they carry is touched. */
export async function unassignCampaignTag(apiKey: string, workspaceId: string, campaignIds: string[], tagId: string): Promise<void> {
  await bulkTag(apiKey, workspaceId, campaignIds, tagId, "UNASSIGN");
}

async function bulkTag(apiKey: string, workspaceId: string, campaignIds: string[], tagId: string, action: "ASSIGN" | "UNASSIGN"): Promise<void> {
  if (campaignIds.length === 0) return;
  await acquireSlot();
  await plusvibePut({
    apiKey,
    path: "/campaign/bulk-assign-tags",
    body: { workspace_id: workspaceId, ids: campaignIds, tag_id: tagId, action },
  });
}

/** The tag ids on a raw campaign, whether the listing gives ids or objects. */
export function tagIdsOf(raw: Record<string, unknown>): string[] {
  const list = raw.tags;
  if (!Array.isArray(list)) return [];
  return list
    .map((t) => (t && typeof t === "object" ? String((t as { id?: unknown; _id?: unknown }).id ?? (t as { _id?: unknown })._id ?? "") : String(t)))
    .filter(Boolean);
}

/** Every campaign in the workspace with the tag ids it carries right now. */
export async function readCampaignTags(apiKey: string, workspaceId: string): Promise<Map<string, string[]>> {
  await acquireSlot();
  const out = new Map<string, string[]>();
  for (const c of await listCampaignsRaw(apiKey, workspaceId)) out.set(String(c.id ?? c._id), tagIdsOf(c));
  return out;
}
