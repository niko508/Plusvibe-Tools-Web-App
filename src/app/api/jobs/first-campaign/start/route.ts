import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { createJob, ActiveJobError } from "@/lib/jobs/first-campaign";
import type { FirstCampaignStartPayload } from "@/lib/jobs/first-campaign-types";

export const dynamic = "force-dynamic";

// POST /api/jobs/first-campaign/start
// Body: { workspaceId, workspaceName }
//
// The campaign name is fixed (TEMPLATE CAMPAIGN), so there is nothing to
// validate beyond the workspace.
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

    const jobId = await createJob(apiKey, {
      workspaceId,
      workspaceName: String(body.workspaceName ?? "").trim(),
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
