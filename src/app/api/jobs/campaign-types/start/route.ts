import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { createJob, QueueRejectedError } from "@/lib/jobs/campaign-types";
import type { CampaignTypesStartPayload } from "@/lib/jobs/campaign-types-types";
import { normalizeName } from "@/lib/campaign-types/match";

export const dynamic = "force-dynamic";

// POST /api/jobs/campaign-types/start
// Body: { workspaceId, workspaceName, sourceCampaignId, sourceCampaignName,
//         names: { blue, optOut, blueOptOut, signature, blueSignature },
//         activate? }
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as Partial<CampaignTypesStartPayload>;

    const workspaceId = String(body.workspaceId ?? "");
    const sourceCampaignId = String(body.sourceCampaignId ?? "");
    if (!workspaceId || !sourceCampaignId) {
      return NextResponse.json(
        { error: "workspaceId and sourceCampaignId are required" },
        { status: 400 }
      );
    }

    const names = {
      blue: String(body.names?.blue ?? "").trim(),
      optOut: String(body.names?.optOut ?? "").trim(),
      blueOptOut: String(body.names?.blueOptOut ?? "").trim(),
      signature: String(body.names?.signature ?? "").trim(),
      blueSignature: String(body.names?.blueSignature ?? "").trim(),
    };
    for (const [role, name] of Object.entries(names)) {
      if (!name) {
        return NextResponse.json(
          { error: `No name for the "${role}" campaign.` },
          { status: 400 }
        );
      }
    }

    // Two copies under the same name would be indistinguishable afterwards,
    // and the run's own reuse check would then adopt one for both roles.
    const keys = Object.values(names).map(normalizeName);
    if (new Set(keys).size !== keys.length) {
      return NextResponse.json(
        { error: "Two of the new campaigns would have the same name." },
        { status: 400 }
      );
    }
    const sourceName = String(body.sourceCampaignName ?? "").trim();
    if (keys.includes(normalizeName(sourceName))) {
      return NextResponse.json(
        {
          error:
            "One of the new campaigns would have the same name as the original.",
        },
        { status: 400 }
      );
    }

    const jobId = await createJob(apiKey, {
      workspaceId,
      workspaceName: String(body.workspaceName ?? ""),
      sourceCampaignId,
      sourceCampaignName: sourceName,
      names,
      activate: body.activate !== false,
    });

    return NextResponse.json({ jobId });
  } catch (err) {
    // Starting while a job runs is normal now — it queues. A 409 here means the
    // job could not even be queued (a duplicate, or a full queue).
    if (err instanceof QueueRejectedError) {
      return NextResponse.json(
        { error: err.message, existingJobId: err.existingJobId },
        { status: 409 }
      );
    }
    return errorResponse(err);
  }
}
