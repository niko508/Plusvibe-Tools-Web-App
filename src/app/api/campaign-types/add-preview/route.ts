import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { fetchCampaignLeads } from "@/lib/plusvibe-leads";
import { segmentOf } from "@/lib/campaign-types/segments";
import { countSegments } from "@/lib/campaign-types/add-leads";

export const dynamic = "force-dynamic";

const MAX_LEADS = 100_000;

// POST /api/campaign-types/add-preview  { workspaceId, campaignId }
// -> { total, segments: [{ segment, count }], hitPageLimit }
// Reads the source's not-contacted leads — the ones a run would move — and
// counts them by segment, so the page can say where each will go before
// anything moves. Nothing is written.
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json().catch(() => ({}))) as { workspaceId?: unknown; campaignId?: unknown };
    const workspaceId = String(body.workspaceId ?? "").trim();
    const campaignId = String(body.campaignId ?? "").trim();
    if (!workspaceId || !campaignId) return NextResponse.json({ error: "workspaceId and campaignId are required" }, { status: 400 });
    const { leads, hitPageLimit } = await fetchCampaignLeads(apiKey, workspaceId, campaignId, MAX_LEADS);
    return NextResponse.json({ total: leads.length, segments: countSegments(leads.map(segmentOf)), hitPageLimit });
  } catch (err) {
    return errorResponse(err);
  }
}
