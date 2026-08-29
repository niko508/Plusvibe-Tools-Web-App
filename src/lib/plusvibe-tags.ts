import "server-only";

import { plusvibeGet } from "@/lib/plusvibe-server";

// Listing a workspace's tags.
//
// The page size matters: /tags/list rejects a limit above 100 with
//   limit: "limit" must be less than or equal to 100
// which is a 400, not a truncated result — so asking for 1000 in one go
// doesn't return fewer tags, it returns none at all. Everything that reads
// tags goes through here so that cap is enforced in exactly one place.

const PAGE_LIMIT = 100; // API max
const MAX_PAGES = 50;

export interface Tag {
  id: string;
  name: string;
}

const ID_RE = /^[a-fA-F0-9]{24}$/;

export async function listTags(
  apiKey: string,
  workspaceId: string,
  signal?: AbortSignal
): Promise<Tag[]> {
  const out: Tag[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await plusvibeGet<unknown>({
      apiKey,
      path: "/tags/list",
      query: {
        workspace_id: workspaceId,
        skip: String(page * PAGE_LIMIT),
        limit: String(PAGE_LIMIT),
      },
      signal,
    });
    const raw = Array.isArray(data)
      ? (data as Array<Record<string, unknown>>)
      : Array.isArray((data as { tags?: unknown })?.tags)
        ? ((data as { tags: Array<Record<string, unknown>> }).tags)
        : [];
    for (const t of raw) {
      const id = String(t.id ?? t._id ?? "").trim();
      const name = String(t.name ?? "").trim();
      if (id && name) out.push({ id, name });
    }
    if (raw.length < PAGE_LIMIT) break;
  }
  return out;
}

/** Finds a tag by name, case-insensitively. Null when the workspace has none. */
export function findTagByName(tags: Tag[], name: string): Tag | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  return (
    tags.find(
      (t) => t.name.trim().toLowerCase() === wanted && ID_RE.test(t.id)
    ) ?? null
  );
}
