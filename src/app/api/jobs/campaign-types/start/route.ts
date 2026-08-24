import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { createJob, ActiveJobError } from "@/lib/jobs/campaign-types";
import type {
  CampaignRole,
  CampaignTypesStartPayload,
  RoleCampaign,
} from "@/lib/jobs/campaign-types-types";

export const dynamic = "force-dynamic";

const ROLES: CampaignRole[] = ["source", "blue", "optOut", "blueOptOut"];

// POST /api/jobs/campaign-types/start
// Body: { workspaceId, workspaceName, campaigns: RoleCampaign[], skipOptOutCopy? }
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as Partial<CampaignTypesStartPayload>;

    const workspaceId = String(body.workspaceId ?? "");
    if (!workspaceId) {
      return NextResponse.json(
        { error: "workspaceId is required" },
        { status: 400 }
      );
    }

    const campaigns = Array.isArray(body.campaigns) ? body.campaigns : [];
    // Every role must be filled: a missing one would silently skip a
    // destination and leave that share of the leads in the source campaign.
    for (const role of ROLES) {
      const entry = campaigns.find((c) => c?.role === role);
      if (!entry?.campaignId) {
        return NextResponse.json(
          { error: `No campaign selected for the "${role}" role.` },
          { status: 400 }
        );
      }
    }

    // Two roles pointing at the same campaign would move a bucket into a
    // campaign that already holds another, or into the source itself.
    const ids = campaigns.map((c) => c.campaignId);
    if (new Set(ids).size !== ids.length) {
      return NextResponse.json(
        { error: "The same campaign is selected for more than one role." },
        { status: 400 }
      );
    }

    const clean: RoleCampaign[] = ROLES.map((role) => {
      const c = campaigns.find((x) => x.role === role)!;
      return {
        role,
        campaignId: String(c.campaignId),
        name: String(c.name ?? ""),
      };
    });

    const jobId = await createJob(apiKey, {
      workspaceId,
      workspaceName: String(body.workspaceName ?? ""),
      campaigns: clean,
      skipOptOutCopy: body.skipOptOutCopy === true,
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
