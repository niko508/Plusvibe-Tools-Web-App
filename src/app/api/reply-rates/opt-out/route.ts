import { NextResponse } from "next/server";
import { plusvibeGet, resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { acquireSlot } from "@/lib/jobs/rate-limit";
import { listCampaigns } from "@/lib/plusvibe-campaigns";
import { parseVariationStats } from "@/lib/winning-variants/plan";
import { checkRange, figuresFrom, type CampaignFigures } from "@/lib/reply-rates/opt-out";

export const dynamic = "force-dynamic";

// POST /api/reply-rates/opt-out  { workspaceId, workspaceName, start, end }
// -> { campaigns: CampaignFigures[], errors: string[] }
// Every campaign in one workspace (sub-sequences aside — their leads are the
// parent's), each with its leads emailed and positive replies in the range.
// The page asks workspace by workspace, so "all workspaces" shows progress
// and one slow workspace never times the whole thing out.
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const workspaceId = String(body.workspaceId ?? "").trim();
    const workspaceName = String(body.workspaceName ?? "").trim();
    if (!workspaceId) return NextResponse.json({ error: "workspaceId is required" }, { status: 400 });
    const today = new Date().toISOString().slice(0, 10);
    const range = checkRange(String(body.start ?? ""), String(body.end ?? ""), today);
    if ("problem" in range) return NextResponse.json({ error: range.problem }, { status: 400 });

    await acquireSlot();
    const list = await listCampaigns(apiKey, workspaceId, { campaignType: "parent" });
    const campaigns: CampaignFigures[] = [];
    const errors: string[] = [];
    for (const c of list) {
      try {
        await acquireSlot();
        const data = await plusvibeGet<unknown>({
          apiKey,
          path: "/campaign/get/variation-stats",
          query: { workspace_id: workspaceId, campaign_id: c.id, start_date: range.start, end_date: range.end },
        });
        campaigns.push({ workspaceId, workspaceName, campaignId: c.id, name: c.name, ...figuresFrom(parseVariationStats(data)) });
      } catch (err) {
        // One campaign that won't answer is named, not a reason to lose the rest.
        errors.push(`${workspaceName || workspaceId} · ${c.name}: ${err instanceof Error ? err.message : "could not be read"}`);
      }
    }
    return NextResponse.json({ campaigns, errors });
  } catch (err) {
    return errorResponse(err);
  }
}
