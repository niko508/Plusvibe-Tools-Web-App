import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import {
  fetchStatusCounts,
  notContactedCount,
  totalCount,
} from "@/lib/plusvibe-leads";

export const dynamic = "force-dynamic";

// GET /api/plusvibe/leads/preview?workspace_id=...&campaign_id=...
// How many not-contacted leads a campaign has available to move.
export async function GET(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const { searchParams } = new URL(request.url);
    const workspace_id = searchParams.get("workspace_id");
    const campaign_id = searchParams.get("campaign_id");
    if (!workspace_id || !campaign_id) {
      return NextResponse.json(
        { error: "workspace_id and campaign_id are required" },
        { status: 400 }
      );
    }

    const counts = await fetchStatusCounts(apiKey, workspace_id, campaign_id);
    // `available` is the movable subset, not the campaign total.
    return NextResponse.json({
      available: notContactedCount(counts),
      total: totalCount(counts),
      counts,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
