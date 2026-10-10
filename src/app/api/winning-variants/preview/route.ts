import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { MAX_WINNER_CAMPAIGNS, previewWinners } from "@/lib/winning-variants/run";

export const dynamic = "force-dynamic";

// POST /api/winning-variants/preview  { workspaceId, campaignId, alsoIds? }
// alsoIds: other campaigns whose step-1 winners join campaignId's.
// The campaign's step-1 variants with their all-time figures, which would be
// kept, the top three, and its tags — nothing is created.
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json().catch(() => ({}))) as { workspaceId?: string; campaignId?: string; alsoIds?: unknown };
    const workspaceId = String(body.workspaceId ?? "");
    const campaignId = String(body.campaignId ?? "");
    if (!workspaceId || !campaignId) return NextResponse.json({ error: "Pick a workspace and a campaign." }, { status: 400 });
    const alsoIds = Array.isArray(body.alsoIds) ? body.alsoIds.map((x) => String(x ?? "")).filter(Boolean) : [];
    if (alsoIds.length >= MAX_WINNER_CAMPAIGNS) return NextResponse.json({ error: `At most ${MAX_WINNER_CAMPAIGNS} campaigns at a time.` }, { status: 400 });
    return NextResponse.json(await previewWinners(apiKey, workspaceId, campaignId, alsoIds));
  } catch (err) {
    if (err instanceof Error && !("status" in err)) return NextResponse.json({ error: err.message }, { status: 400 });
    return errorResponse(err);
  }
}
