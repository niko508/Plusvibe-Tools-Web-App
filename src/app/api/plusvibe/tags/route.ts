import { NextResponse } from "next/server";
import { plusvibeGet, resolveApiKey } from "@/lib/plusvibe-server";
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
    const data = await plusvibeGet<unknown>({
      apiKey,
      path: "/tags/list",
      query: { workspace_id, limit: "1000" },
    });
    const raw = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
    const tags = raw.map((t) => ({
      id: String(t.id ?? t._id ?? ""),
      name: String(t.name ?? ""),
    }));
    return NextResponse.json({ tags });
  } catch (err) {
    return errorResponse(err);
  }
}
