import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { listTags } from "@/lib/plusvibe-tags";
import { errorResponse } from "@/lib/api-response";

export const dynamic = "force-dynamic";

// GET /api/plusvibe/tags?workspace_id=...
// Returns the workspace's tags as { tags: [{ id, name }] }.
export async function GET(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const { searchParams } = new URL(request.url);
    const workspace_id = searchParams.get("workspace_id") ?? undefined;
    if (!workspace_id) {
      return NextResponse.json(
        { error: "workspace_id is required" },
        { status: 400 }
      );
    }
    // Paged: /tags/list rejects a limit above 100 outright, so the old
    // limit=1000 returned a 400 rather than every tag.
    const tags = await listTags(apiKey, workspace_id);
    return NextResponse.json({ tags });
  } catch (err) {
    return errorResponse(err);
  }
}
