import { fetchAccounts } from "@/lib/api-client";
import { mapPool } from "@/lib/concurrency";
import { domainFromEmail } from "@/lib/format";
import type { Workspace } from "@/lib/plusvibe-types";
import type { IndexEntry } from "./types";

// Scans the given workspaces, listing every inbox and building a
// `domain -> IndexEntry[]` index. This is one pass over the inventory,
// independent of how many domains the user pasted.
export async function buildDomainIndex(
  workspaces: Workspace[],
  opts: { concurrency: number; spacingMs: number; signal?: AbortSignal },
  onProgress: (done: number, total: number) => void
): Promise<{ index: Map<string, IndexEntry[]>; workspaceNames: Record<string, string> }> {
  const index = new Map<string, IndexEntry[]>();
  const workspaceNames: Record<string, string> = {};
  let done = 0;

  await mapPool(
    workspaces,
    async (ws) => {
      const res = await fetchAccounts({ workspace_id: ws._id }, opts.signal);
      workspaceNames[ws._id] = ws.name;
      for (const acc of res.accounts ?? []) {
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

  return { index, workspaceNames };
}
