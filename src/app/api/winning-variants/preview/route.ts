import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { previewWinners } from "@/lib/winning-variants/run";

export const dynamic = "force-dynamic";

// POST /api/winning-variants/preview  { workspaceId, campaignId }
// The campaign's step-1 variants with their all-time figures, which would be
// kept, the top three, and its tags — nothing is created.
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json().catch(() => ({}))) as { workspaceId?: string; campaignId?: string };
    const workspaceId = String(body.workspaceId ?? "");
    const campaignId = String(body.campaignId ?? "");
    if (!workspaceId || !campaignId) return NextResponse.json({ error: "Pick a workspace and a campaign." }, { status: 400 });
    return NextResponse.json(await previewWinners(apiKey, workspaceId, campaignId));
  } catch (err) {
    if (err instanceof Error && !("status" in err)) return NextResponse.json({ error: err.message }, { status: 400 });
    return errorResponse(err);
  }
}
