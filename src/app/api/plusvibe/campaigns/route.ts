import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { listCampaigns } from "@/lib/plusvibe-campaigns";

export const dynamic = "force-dynamic";

// GET /api/plusvibe/campaigns?workspace_id=...
// Lists every parent campaign in the workspace (paginated server-side).
// Status filtering is left to the client: the API has no DRAFT status and
// doesn't accept INACTIVE as a `status` query value, so filtering here would
// silently hide campaigns.
export async function GET(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const { searchParams } = new URL(request.url);
    const workspace_id = searchParams.get("workspace_id");
    if (!workspace_id) {
      return NextResponse.json(
        { error: "workspace_id is required" },
        { status: 400 }
      );
    }
    const campaigns = await listCampaigns(apiKey, workspace_id);
    return NextResponse.json({ campaigns });
  } catch (err) {
    return errorResponse(err);
  }
}
