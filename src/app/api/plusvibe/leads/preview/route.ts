import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import {
  fetchCampaignLeads,
  fetchStatusCounts,
  leadToPayload,
  totalCount,
} from "@/lib/plusvibe-leads";

export const dynamic = "force-dynamic";

// GET /api/plusvibe/leads/preview?workspace_id=…&campaign_id=…
// Pre-flight for a move: how many leads the source holds, and exactly which
// fields would be carried across for a sample lead — so it's visible up front
// whether personalization (opening_line etc.) survives.
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
    const available = totalCount(counts);

    // One page is enough to show what a carried lead looks like.
    const { leads } = await fetchCampaignLeads(
      apiKey,
      workspace_id,
      campaign_id,
      1
    );
    const sample = leads[0];
    const payload = sample ? leadToPayload(sample) : null;

    return NextResponse.json({
      available,
      counts,
      sample: payload
        ? {
            topLevelFields: Object.keys(payload).filter(
              (k) => k !== "custom_variables"
            ),
            customVariables: Object.keys(payload.custom_variables ?? {}),
          }
        : null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
