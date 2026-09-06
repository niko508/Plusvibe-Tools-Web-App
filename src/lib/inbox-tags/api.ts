import "server-only";

import { acquireSlot } from "@/lib/jobs/rate-limit";
import { plusvibeGet, plusvibePost, plusvibePut } from "@/lib/plusvibe-server";
import { listTags } from "@/lib/plusvibe-tags";
import { classifyApiError, findExisting } from "@/lib/tags/bulk-tags";
import type { InboxLite } from "@/lib/inbox-tags/plan";

// The Plusvibe calls the inbox-tagging jobs share: reading inboxes a page at
// a time, finding-or-creating a tag, and the additive bulk assign.

export const ACCOUNTS_PAGE = 100;
export const ACCOUNTS_MAX_PAGES = 200; // 20k inboxes

function msg(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

export function toInbox(a: Record<string, unknown>): InboxLite {
  const payload = (a.payload ?? {}) as Record<string, unknown>;
  const rawTags = Array.isArray(payload.tags) ? payload.tags : Array.isArray(a.tags) ? a.tags : [];
  return {
    id: String(a.id ?? a._id ?? ""),
    email: String(a.email ?? ""),
    provider: a.provider ? String(a.provider) : undefined,
    tags: (rawTags as unknown[])
      .map((t) => (t && typeof t === "object" ? String((t as { id?: unknown; _id?: unknown }).id ?? (t as { _id?: unknown })._id ?? "") : String(t)))
      .filter(Boolean),
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

/** Adds one tag to these inboxes. Additive: whatever they carry stays. */
export async function assignTag(apiKey: string, workspaceId: string, ids: string[], tagId: string): Promise<void> {
  if (ids.length === 0) return;
  await acquireSlot();
  await plusvibePut({
    apiKey,
    path: "/account/bulk-assign-tags",
    body: { workspace_id: workspaceId, ids, tag_id: tagId, action: "ASSIGN" },
  });
}
