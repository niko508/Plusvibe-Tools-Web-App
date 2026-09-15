import "server-only";

import { acquireSlot } from "@/lib/jobs/rate-limit";
import { plusvibeGet, plusvibePost, plusvibePut } from "@/lib/plusvibe-server";
import { listTags } from "@/lib/plusvibe-tags";
import { classifyApiError, findExisting } from "@/lib/tags/bulk-tags";
import type { CampaignLite, InboxLite, Level, TagAction } from "@/lib/inbox-tags/plan";

// The Plusvibe calls the tagging jobs share: reading inboxes or campaigns a
// page at a time, finding-or-creating a tag, and the targeted bulk assign.

export const ACCOUNTS_PAGE = 100;
export const ACCOUNTS_MAX_PAGES = 200; // 20k inboxes
export const CAMPAIGNS_PAGE = 100;
export const CAMPAIGNS_MAX_PAGES = 100; // 10k campaigns

function msg(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

/** Tag ids, however the API spells them: bare strings or objects with an id. */
function tagIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t) =>
      t && typeof t === "object"
        ? String((t as { id?: unknown; _id?: unknown }).id ?? (t as { _id?: unknown })._id ?? "")
        : String(t)
    )
    .filter(Boolean);
}

export function toInbox(a: Record<string, unknown>): InboxLite {
  const payload = (a.payload ?? {}) as Record<string, unknown>;
  return {
    id: String(a.id ?? a._id ?? ""),
    email: String(a.email ?? ""),
    provider: a.provider ? String(a.provider) : undefined,
    tags: tagIds(Array.isArray(payload.tags) ? payload.tags : a.tags),
  };
}

export function toCampaign(c: Record<string, unknown>): CampaignLite {
  return {
    id: String(c.id ?? c._id ?? ""),
    name: String(c.camp_name ?? c.name ?? "") || "(untitled)",
    status: c.status ? String(c.status) : undefined,
    tags: tagIds(c.tags),
  };
}

export async function readInboxPage(apiKey: string, workspaceId: string, skip: number, limit: number): Promise<InboxLite[]> {
  await acquireSlot();
  const data = await plusvibeGet<{ accounts?: Record<string, unknown>[] }>({
    apiKey,
    path: "/account/list",
    query: { workspace_id: workspaceId, skip: String(skip), limit: String(limit) },
  });
  return (Array.isArray(data?.accounts) ? data.accounts : []).map(toInbox);
}

/** Finds the tag in the workspace by name, creating it when missing. */
export async function resolveTag(
  apiKey: string,
  workspaceId: string,
  existing: { id: string; name: string }[],
  name: string,
  color: string
): Promise<{ id: string; created: boolean }> {
  const found = findExisting(name, existing);
  if (found) return { id: found.id, created: false };
  await acquireSlot();
  try {
    const res = await plusvibePost<{ tag_id?: string; id?: string; _id?: string }>({
      apiKey,
      path: "/tags/create",
      body: { workspace_id: workspaceId, name, color },
    });
    const id = String(res?.tag_id ?? res?.id ?? res?._id ?? "");
    if (id) return { id, created: true };
  } catch (err) {
    // Created by someone in the meantime: read again rather than fail.
    if (classifyApiError(msg(err)) !== "already") throw err;
  }
  await acquireSlot();
  const again = findExisting(name, await listTags(apiKey, workspaceId));
  if (!again) throw new Error(`Created the tag "${name}" but could not read its id back.`);
  return { id: again.id, created: false };
}

/**
 * One page of campaigns. Sub-sequences are left out unless asked for: they are
 * campaigns in their own right on /campaign/list-all, but Plusvibe's campaign
 * list shows their parents, which is what a tag is normally filed under.
 */
export async function readCampaignPage(
  apiKey: string,
  workspaceId: string,
  skip: number,
  limit: number,
  includeSubsequences = false
): Promise<CampaignLite[]> {
  await acquireSlot();
  const data = await plusvibeGet<unknown>({
    apiKey,
    path: "/campaign/list-all",
    query: {
      workspace_id: workspaceId,
      campaign_type: includeSubsequences ? "all" : "parent",
      skip: String(skip),
      limit: String(limit),
    },
  });
  const raw = Array.isArray(data)
    ? data
    : Array.isArray((data as { campaigns?: unknown })?.campaigns)
      ? (data as { campaigns: unknown[] }).campaigns
      : [];
  return (raw as Record<string, unknown>[]).map(toCampaign).filter((c) => c.id);
}

/**
 * Moves one tag on or off these inboxes or campaigns. Targeted either way:
 * assigning leaves whatever else they carry, removing takes only this one off.
 */
export async function applyTag(
  apiKey: string,
  workspaceId: string,
  ids: string[],
  tagId: string,
  level: Level = "inboxes",
  action: TagAction = "add"
): Promise<void> {
  if (ids.length === 0) return;
  await acquireSlot();
  await plusvibePut({
    apiKey,
    path: level === "campaigns" ? "/campaign/bulk-assign-tags" : "/account/bulk-assign-tags",
    body: {
      workspace_id: workspaceId,
      ids,
      tag_id: tagId,
      action: action === "remove" ? "UNASSIGN" : "ASSIGN",
    },
  });
}

/** Adds one tag to these inboxes. Additive: whatever they carry stays. */
export async function assignTag(apiKey: string, workspaceId: string, ids: string[], tagId: string): Promise<void> {
  return applyTag(apiKey, workspaceId, ids, tagId, "inboxes", "add");
}
