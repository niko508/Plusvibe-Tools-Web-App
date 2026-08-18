import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import {
  fetchCampaignRaw,
  fetchKnownVariationLabels,
  toCampaignDetail,
} from "@/lib/plusvibe-campaigns";

export const dynamic = "force-dynamic";

// GET /api/plusvibe/campaign?workspace_id=...&campaign_id=...
// Returns one campaign's steps, their existing variations and subject line, plus
// warnings about variants that exist but can't be preserved through a write.
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

    const raw = await fetchCampaignRaw(apiKey, workspace_id, campaign_id);
    if (!raw) {
      return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
    }
    const known = await fetchKnownVariationLabels(
      apiKey,
      workspace_id,
      campaign_id
    );
    return NextResponse.json(toCampaignDetail(raw, known));
  } catch (err) {
    return errorResponse(err);
  }
}
