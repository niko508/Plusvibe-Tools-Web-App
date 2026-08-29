import "server-only";

// Plusvibe calls the Blocked Domains automation needs, in the shapes it needs
// them: list workspaces, page an entire workspace's inboxes, stop an inbox
// sending, and delete it.

import {
  plusvibeGet,
  plusvibePut,
  plusvibePatch,
  plusvibePost,
} from "@/lib/plusvibe-server";
import { acquireSlot } from "@/lib/jobs/rate-limit";
import type { Workspace } from "@/lib/plusvibe-types";

const PAGE_SIZE = 100;
/** Enough for the largest workspace with room to spare. */
const MAX_PAGES = 200;

export interface Inbox {
  id: string;
  email: string;
}

export async function listWorkspaces(apiKey: string): Promise<Workspace[]> {
  await acquireSlot();
  const data = await plusvibeGet<{ workspaces?: Workspace[] }>({
    apiKey,
    path: "/authenticate",
  });
  return (data.workspaces ?? []).filter((w) => w && w._id);
}

/**
 * Every inbox in a workspace.
 *
 * Paged through the shared rate limiter, because this runs unattended
 * alongside whatever else the app is doing and a domain scan can otherwise
 * spend the whole 5 req/s budget on its own.
 */
export async function listInboxes(
  apiKey: string,
  workspaceId: string
): Promise<Inbox[]> {
  const out: Inbox[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    await acquireSlot();
    const data = await plusvibeGet<unknown>({
      apiKey,
      path: "/account/list",
      query: {
        workspace_id: workspaceId,
        skip: String(page * PAGE_SIZE),
        limit: String(PAGE_SIZE),
      },
    });
    const raw = Array.isArray(data)
      ? (data as Array<Record<string, unknown>>)
      : Array.isArray((data as { accounts?: unknown })?.accounts)
        ? ((data as { accounts: Array<Record<string, unknown>> }).accounts)
        : [];
    for (const a of raw) {
      const id = String(a.id ?? a._id ?? "").trim();
      const email = String(a.email ?? "").trim();
      if (id && email) out.push({ id, email });
    }
    if (raw.length < PAGE_SIZE) break;
  }
  return out;
}

/**
 * Stops a set of inboxes sending, without deleting them.
 *
 * Two calls, because they're two different things to Plusvibe:
 *   - `daily_limit: 0` stops campaign sending (the field allows 0)
 *   - warmup has to be switched off, not zeroed — `warmup_max_daily_limit`
 *     has a documented minimum of 1, so setting it to 0 is rejected
 *
 * This is the reversible half of handling a blocked domain, so it runs before
 * anyone is asked to confirm anything.
 */
export interface QuarantineResult {
  sendingStopped: boolean;
  warmupStopped: boolean;
  errors: string[];
}

export async function quarantineInboxes(
  apiKey: string,
  workspaceId: string,
  ids: string[]
): Promise<QuarantineResult> {
  const result: QuarantineResult = {
    sendingStopped: false,
    warmupStopped: false,
    errors: [],
  };
  if (ids.length === 0) return result;

  // The two halves are attempted independently. If warmup can't be switched
  // off, stopping campaign sending is still worth having — failing both
  // because one endpoint misbehaved would leave the domain sending.
  try {
    await acquireSlot();
    // PUT — /account/bulk-update
    await plusvibePut({
      apiKey,
      path: "/account/bulk-update",
      body: { workspace_id: workspaceId, ids, daily_limit: 0 },
    });
    result.sendingStopped = true;
  } catch (err) {
    result.errors.push(
      `campaign sending: ${err instanceof Error ? err.message : "failed"}`
    );
  }

  try {
    await acquireSlot();
    // PATCH, not PUT — the warmup endpoint is the one method that differs, and
    // Plusvibe answers an unrouted method with a 404 ("Page not found") rather
    // than a 405, which makes the mistake look like a bad path.
    await plusvibePatch({
      apiKey,
      path: "/account/bulk-update-warmup",
      body: { workspace_id: workspaceId, ids, warmup_status: "INACTIVE" },
    });
    result.warmupStopped = true;
  } catch (err) {
    result.errors.push(
      `warmup: ${err instanceof Error ? err.message : "failed"}`
    );
  }

  return result;
}

/** Deletes one inbox. Plusvibe deletes by address, not id. */
export async function deleteInbox(
  apiKey: string,
  workspaceId: string,
  email: string
): Promise<void> {
  await acquireSlot();
  await plusvibePost({
    apiKey,
    path: "/account/delete",
    body: { workspace_id: workspaceId, email },
  });
}
