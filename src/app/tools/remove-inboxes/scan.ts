import { fetchAccounts, fetchTags } from "@/lib/api-client";
import { mapPool } from "@/lib/concurrency";
import { domainFromEmail } from "@/lib/format";
import type { Workspace } from "@/lib/plusvibe-types";
import type { IndexEntry } from "./types";

// Scans the given workspaces, listing every inbox and building a
// `domain -> IndexEntry[]` index. This is one pass over the inventory,
// independent of how many domains the user pasted. Inboxes tagged
// "Master Inbox" are always excluded so they can never be deleted.
export async function buildDomainIndex(
  workspaces: Workspace[],
  opts: { concurrency: number; spacingMs: number; signal?: AbortSignal },
  onProgress: (done: number, total: number) => void
): Promise<{
  index: Map<string, IndexEntry[]>;
  workspaceNames: Record<string, string>;
  excludedMaster: number;
}> {
  const index = new Map<string, IndexEntry[]>();
  const workspaceNames: Record<string, string> = {};
  let excludedMaster = 0;
  let done = 0;

  await mapPool(
    workspaces,
    async (ws) => {
      const [res, tagsRes] = await Promise.all([
        fetchAccounts({ workspace_id: ws._id }, opts.signal),
        fetchTags({ workspace_id: ws._id }, opts.signal).catch(() => ({
          tags: [],
        })),
      ]);
      workspaceNames[ws._id] = ws.name;
      const masterIds = new Set(
        (tagsRes.tags ?? [])
          .filter((t) => t.name.trim().toLowerCase() === "master inbox")
          .map((t) => t.id)
      );
      for (const acc of res.accounts ?? []) {
        if (masterIds.size > 0 && acc.tags?.some((id) => masterIds.has(id))) {
          excludedMaster += 1;
          continue;
        }
        const domain = domainFromEmail(acc.email);
        if (!domain || !acc.id) continue;
        const entry: IndexEntry = {
          workspace_id: ws._id,
          workspaceName: ws.name,
          email: acc.email,
          accountId: acc.id,
        };
        const arr = index.get(domain);
        if (arr) arr.push(entry);
        else index.set(domain, [entry]);
      }
      done += 1;
      onProgress(done, workspaces.length);
    },
    { concurrency: opts.concurrency, minSpacingMs: opts.spacingMs, signal: opts.signal }
  );

  return { index, workspaceNames, excludedMaster };
}
