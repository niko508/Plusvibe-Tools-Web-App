import { fetchAccountsPage, fetchTags } from "@/lib/api-client";
import { mapPool } from "@/lib/concurrency";
import { domainFromEmail } from "@/lib/format";
import type { Workspace } from "@/lib/plusvibe-types";
import type { IndexEntry } from "./types";

const PAGE_SIZE = 100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ScanProgress {
  done: number; // workspaces finished
  total: number; // workspaces to scan
  inboxes: number; // inboxes scanned so far (climbs as pages arrive)
}

// Scans the given workspaces, listing every inbox and building a
// `domain -> IndexEntry[]` index. This is one pass over the inventory,
// independent of how many domains the user pasted. Inboxes tagged
// "Master Inbox" are always excluded so they can never be deleted.
//
// Inboxes are paged client-side so the caller can show a live counter that
// climbs continuously — even while a single large workspace is still loading —
// instead of the bar sitting still until a whole workspace finishes.
export async function buildDomainIndex(
  workspaces: Workspace[],
  opts: { concurrency: number; spacingMs: number; signal?: AbortSignal },
  onProgress: (p: ScanProgress) => void
): Promise<{
  index: Map<string, IndexEntry[]>;
  workspaceNames: Record<string, string>;
  excludedMaster: number;
  /** Addresses left out because they are Master Inboxes, lower-cased. */
  masterEmails: Set<string>;
}> {
  const index = new Map<string, IndexEntry[]>();
  const workspaceNames: Record<string, string> = {};
  const masterEmails = new Set<string>();
  let excludedMaster = 0;
  let done = 0;
  let inboxes = 0;

  await mapPool(
    workspaces,
    async (ws) => {
      workspaceNames[ws._id] = ws.name;
      const tagsRes = await fetchTags(
        { workspace_id: ws._id },
        opts.signal
      ).catch(() => ({ tags: [] }));
      const masterIds = new Set(
        (tagsRes.tags ?? [])
          .filter((t) => t.name.trim().toLowerCase() === "master inbox")
          .map((t) => t.id)
      );

      let skip = 0;
      let firstPage = true;
      while (true) {
        // Space page requests so deep pagination stays near Plusvibe's limit.
        if (!firstPage) await sleep(opts.spacingMs);
        firstPage = false;
        const res = await fetchAccountsPage(
          { workspace_id: ws._id, skip, limit: PAGE_SIZE },
          opts.signal
        );
        for (const acc of res.accounts ?? []) {
          inboxes += 1;
          if (masterIds.size > 0 && acc.tags?.some((id) => masterIds.has(id))) {
            excludedMaster += 1;
            // Remembered so naming one by address says "protected", not "missing".
            if (acc.email) masterEmails.add(acc.email.trim().toLowerCase());
            continue;
          }
          const domain = domainFromEmail(acc.email);
          if (!domain || !acc.id) continue;
          const entry: IndexEntry = {
            workspace_id: ws._id,
            workspaceName: ws.name,
            email: acc.email,
            domain,
            accountId: acc.id,
          };
          const arr = index.get(domain);
          if (arr) arr.push(entry);
          else index.set(domain, [entry]);
        }
        onProgress({ done, total: workspaces.length, inboxes });
        if (!res.hasMore) break;
        skip += PAGE_SIZE;
      }

      done += 1;
      onProgress({ done, total: workspaces.length, inboxes });
    },
    { concurrency: opts.concurrency, minSpacingMs: opts.spacingMs, signal: opts.signal }
  );

  return { index, workspaceNames, excludedMaster, masterEmails };
}
