import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import {
  CampaignEditError,
  editCampaignCopy,
  sanitizeEdit,
} from "@/lib/copy-sections/apply-campaign";

export const dynamic = "force-dynamic";

// POST /api/plusvibe/copy-sections
// Body: { workspace_id, campaign_id, step, edit, dryRun?, expectedVariationCount? }
//
// Applies one edit to every live variation of ONE step. The read-modify-write
// itself lives in editCampaignCopy, shared with the bulk job. A dry run returns
// the per-variation before/after without writing.
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as {
      workspace_id?: string;
      campaign_id?: string;
      step?: number;
      edit?: unknown;
      dryRun?: boolean;
      expectedVariationCount?: number;
    };

    const workspace_id = String(body.workspace_id ?? "");
    const campaign_id = String(body.campaign_id ?? "");
    const step = Number(body.step);
    if (!workspace_id || !campaign_id || !Number.isFinite(step) || step < 1) {
      return NextResponse.json(
        { error: "workspace_id, campaign_id and step are required" },
        { status: 400 }
      );
    }
    const edit = sanitizeEdit(body.edit);
    if (!edit) {
      return NextResponse.json({ error: "Missing or invalid edit." }, { status: 400 });
    }

    const out = await editCampaignCopy({
      apiKey,
      workspaceId: workspace_id,
      campaignId: campaign_id,
      edit,
      step,
      dryRun: body.dryRun === true,
      expectedVariationCount: body.expectedVariationCount,
      includeBodies: true,
    });
    const one = out.steps[0];

    return NextResponse.json({
      step,
      campaignName: out.campaignName,
      total: one?.total ?? 0,
      changed: one?.changed ?? 0,
      droppedDeleted: out.droppedDeleted,
      results: one?.results ?? [],
      dryRun: out.dryRun,
      written: out.written,
      verified: out.verified,
      unverified: out.unverified.map((u) => u.variation),
    });
  } catch (err) {
    if (err instanceof CampaignEditError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorResponse(err);
  }
}
