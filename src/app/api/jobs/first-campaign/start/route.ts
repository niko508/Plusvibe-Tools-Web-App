import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { createJob, ActiveJobError } from "@/lib/jobs/first-campaign";
import type { FirstCampaignStartPayload } from "@/lib/jobs/first-campaign-types";

export const dynamic = "force-dynamic";

// POST /api/jobs/first-campaign/start
// Body: { workspaceId, workspaceName, campaignName }
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as Partial<FirstCampaignStartPayload>;

    const workspaceId = String(body.workspaceId ?? "").trim();
    if (!workspaceId) {
      return NextResponse.json(
        { error: "workspaceId is required" },
        { status: 400 }
      );
    }

    const campaignName = String(body.campaignName ?? "").trim();
    if (!campaignName) {
      return NextResponse.json(
        { error: "Give the campaign a name." },
        { status: 400 }
      );
    }
    // Plusvibe caps campaign names; a rejection here is clearer than one from
    // the API halfway through the run, after labels have already been created.
    if (campaignName.length > 200) {
      return NextResponse.json(
        { error: "That campaign name is too long (200 characters max)." },
        { status: 400 }
      );
    }

    const jobId = await createJob(apiKey, {
      workspaceId,
      workspaceName: String(body.workspaceName ?? "").trim(),
      campaignName,
    });

    return NextResponse.json({ jobId });
  } catch (err) {
    if (err instanceof ActiveJobError) {
      return NextResponse.json(
        { error: err.message, activeJobId: err.activeJobId },
        { status: 409 }
      );
    }
    return errorResponse(err);
  }
}
