import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { acquireSlot } from "@/lib/jobs/rate-limit";
import { fetchNotContactedPage } from "@/lib/plusvibe-leads";
import { flattenLead } from "@/lib/export-leads/rows";

export const dynamic = "force-dynamic";

// GET /api/leads/not-contacted?workspace_id=…&campaign_id=…&page=1
// -> { leads: LeadRow[], more, wrongStatus }
// One page of a campaign's not-contacted leads, each as a flat row (fields
// and custom variables, no bookkeeping). The page drives the paging, so a
// campaign of any size is read without one request having to outlast it.
// Nothing is changed in Plusvibe.
export async function GET(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const q = new URL(request.url).searchParams;
    const workspaceId = q.get("workspace_id") ?? "";
    const campaignId = q.get("campaign_id") ?? "";
    const page = Math.max(1, Math.floor(Number(q.get("page") ?? "1")) || 1);
    if (!workspaceId || !campaignId) return NextResponse.json({ error: "workspace_id and campaign_id are required" }, { status: 400 });
    await acquireSlot();
    const r = await fetchNotContactedPage(apiKey, workspaceId, campaignId, page);
    return NextResponse.json({ leads: r.leads.map(flattenLead), more: r.more, wrongStatus: r.wrongStatus });
  } catch (err) {
    return errorResponse(err);
  }
}
