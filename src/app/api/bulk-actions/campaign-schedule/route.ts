import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { fetchCampaignRaw } from "@/lib/plusvibe-campaigns";
import { weekFromCampaign } from "@/lib/campaign-settings/schedule";

export const dynamic = "force-dynamic";

// GET /api/bulk-actions/campaign-schedule?workspace_id=&campaign_id=
//   → { week, exact } — one campaign's sending schedule as a week, for
//     copying it onto others.
//
// `exact` is false when it was rebuilt from the simple one-window schedule,
// which is all /campaign/list-all documents; true when the campaign reported
// an advanced schedule of its own.
export async function GET(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const { searchParams } = new URL(request.url);
    const workspaceId = (searchParams.get("workspace_id") ?? "").trim();
    const campaignId = (searchParams.get("campaign_id") ?? "").trim();
    if (!workspaceId || !campaignId) {
      return NextResponse.json({ error: "workspace_id and campaign_id are required" }, { status: 400 });
    }
    const raw = (await fetchCampaignRaw(apiKey, workspaceId, campaignId)) as Record<string, unknown> | null;
    if (!raw) return NextResponse.json({ error: "No such campaign." }, { status: 404 });
    const found = weekFromCampaign(raw);
    if (!found) {
      return NextResponse.json({ error: "That campaign doesn't report a sending schedule." }, { status: 404 });
    }
    return NextResponse.json(found);
  } catch (err) {
    return errorResponse(err);
  }
}
