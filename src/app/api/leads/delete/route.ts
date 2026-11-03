import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { acquireSlot } from "@/lib/jobs/rate-limit";
import { deleteCampaignLeads } from "@/lib/plusvibe-leads";
import { DELETE_CHUNK } from "@/lib/export-leads/rows";

export const dynamic = "force-dynamic";

// POST /api/leads/delete  { workspaceId, campaignId, emails: string[] } -> { deleted }
// Deletes up to 100 leads, by email, from one campaign — never without one,
// which would delete them workspace-wide. Export/Remove Not Contacted Leads calls it
// only for leads it has just seen still not contacted.
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json().catch(() => ({}))) as { workspaceId?: unknown; campaignId?: unknown; emails?: unknown };
    const workspaceId = String(body.workspaceId ?? "").trim();
    const campaignId = String(body.campaignId ?? "").trim();
    const emails = Array.isArray(body.emails) ? body.emails.map((e) => String(e ?? "").trim()).filter((e) => e.includes("@")) : [];
    if (!workspaceId || !campaignId) return NextResponse.json({ error: "workspaceId and campaignId are required." }, { status: 400 });
    if (emails.length === 0) return NextResponse.json({ error: "No emails to delete." }, { status: 400 });
    if (emails.length > DELETE_CHUNK) return NextResponse.json({ error: `At most ${DELETE_CHUNK} at a time.` }, { status: 400 });
    await acquireSlot();
    await deleteCampaignLeads(apiKey, workspaceId, campaignId, emails);
    return NextResponse.json({ deleted: emails.length });
  } catch (err) {
    return errorResponse(err);
  }
}
