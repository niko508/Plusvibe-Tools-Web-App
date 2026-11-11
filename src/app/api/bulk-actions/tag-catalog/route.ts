import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { acquireSlot } from "@/lib/jobs/rate-limit";
import { listTags } from "@/lib/plusvibe-tags";
import { buildCatalog, type CatalogTag } from "@/lib/inbox-tags/plan";

export const dynamic = "force-dynamic";

const MAX_WORKSPACES = 200;

export interface TagCatalogResponse {
  tags: CatalogTag[];
  /** Workspaces whose tags were read. */
  read: number;
  failed: { workspaceId: string; workspaceName: string; reason: string }[];
}

// POST /api/bulk-actions/tag-catalog   { workspaces: [{ id, name }] }
//
// The tags in use across the given workspaces, merged by name, so a panel can
// offer them as choices instead of asking for a name to be typed.
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as { workspaces?: { id?: string; name?: string }[] };
    const workspaces = (body.workspaces ?? [])
      .map((w) => ({ id: String(w?.id ?? ""), name: String(w?.name ?? "") }))
      .filter((w) => w.id);
    if (workspaces.length === 0) {
      return NextResponse.json({ error: "Pick at least one workspace." }, { status: 400 });
    }
    if (workspaces.length > MAX_WORKSPACES) {
      return NextResponse.json({ error: `Too many workspaces (${workspaces.length}); the limit is ${MAX_WORKSPACES}.` }, { status: 400 });
    }

    const perWorkspace: { name: string; color?: string }[][] = [];
    const failed: TagCatalogResponse["failed"] = [];
    for (const ws of workspaces) {
      try {
        await acquireSlot();
        perWorkspace.push(await listTags(apiKey, ws.id));
      } catch (err) {
        failed.push({ workspaceId: ws.id, workspaceName: ws.name, reason: err instanceof Error ? err.message : "Unknown error" });
      }
    }
    const out: TagCatalogResponse = { tags: buildCatalog(perWorkspace), read: perWorkspace.length, failed };
    return NextResponse.json(out);
  } catch (err) {
    return errorResponse(err);
  }
}
