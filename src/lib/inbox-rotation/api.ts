import "server-only";

import { acquireSlot } from "@/lib/jobs/rate-limit";
import { plusvibePut } from "@/lib/plusvibe-server";
import { findTagByName, listTags } from "@/lib/plusvibe-tags";
import { ACCOUNTS_MAX_PAGES, ACCOUNTS_PAGE, readInboxPage } from "@/lib/inbox-tags/api";
import { chunk } from "@/lib/inbox-tags/plan";
import type { InboxLite } from "@/lib/inbox-tags/plan";
import { GROUP_TAG_NAMES, type Group } from "./settings";
import type { GroupTagIds } from "./inventory";

// The Plusvibe calls the rotation makes: the group tags' ids, every inbox in
// the workspace, and the bulk write of settings to a set of inboxes.

const WRITE_CHUNK = 100;

/** The ids of the two group tags, whichever of them the workspace has. */
export async function findGroupTags(apiKey: string, workspaceId: string): Promise<GroupTagIds> {
  await acquireSlot();
  const tags = await listTags(apiKey, workspaceId);
  const out: GroupTagIds = {};
  for (const g of [1, 2] as Group[]) {
    const t = findTagByName(tags, GROUP_TAG_NAMES[g]);
    if (t) out[g] = t.id;
  }
  return out;
}

/** Every inbox in the workspace, tagged or not — the domain counts need them all. */
export async function fetchAllInboxes(apiKey: string, workspaceId: string): Promise<InboxLite[]> {
  const all: InboxLite[] = [];
  for (let page = 0; page < ACCOUNTS_MAX_PAGES; page++) {
    const batch = await readInboxPage(apiKey, workspaceId, page * ACCOUNTS_PAGE, ACCOUNTS_PAGE);
    all.push(...batch);
    if (batch.length < ACCOUNTS_PAGE) break;
  }
  return all;
}

/** Writes the same settings to these inboxes, a hundred at a time. Returns how many were written. */
export async function writeSettings(
  apiKey: string,
  workspaceId: string,
  ids: string[],
  body: Record<string, number | string>,
  onError: (count: number, message: string) => void
): Promise<number> {
  let written = 0;
  for (const part of chunk(ids, WRITE_CHUNK)) {
    try {
      await acquireSlot();
      await plusvibePut({ apiKey, path: "/account/bulk-update", body: { workspace_id: workspaceId, ids: part, ...body } });
      written += part.length;
    } catch (err) {
      onError(part.length, err instanceof Error ? err.message : "failed");
    }
  }
  return written;
}
