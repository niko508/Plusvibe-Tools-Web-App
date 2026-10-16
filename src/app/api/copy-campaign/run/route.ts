import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { copyCampaign, PartialCopyError } from "@/lib/copy-campaign/run";
import { planProblems } from "@/lib/copy-campaign/plan";

export const dynamic = "force-dynamic";

// POST /api/copy-campaign/run
// Duplicates the destination campaign in its own workspace, then writes the
// source campaign's copy over the new campaign's parent sequences.
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as {
      sourceWorkspaceId?: string;
      sourceCampaignId?: string;
      destWorkspaceId?: string;
      destCampaignId?: string;
      name?: string;
      duplicateSubsequences?: boolean;
    };

    const sel = {
      sourceWorkspaceId: String(body.sourceWorkspaceId ?? ""),
      sourceCampaignId: String(body.sourceCampaignId ?? ""),
      destWorkspaceId: String(body.destWorkspaceId ?? ""),
      destCampaignId: String(body.destCampaignId ?? ""),
      name: String(body.name ?? ""),
    };
    // Re-checked here rather than trusted from the browser: this is the last
    // point before a campaign is created.
    const problems = planProblems(sel);
    if (problems.length > 0) {
      return NextResponse.json({ error: problems[0] }, { status: 400 });
    }

    const result = await copyCampaign({
      apiKey,
      ...sel,
      name: sel.name.trim(),
      duplicateSubsequences: body.duplicateSubsequences !== false,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof PartialCopyError) {
      // 409: the copy exists but is empty, and the user has to know its name.
      return NextResponse.json(
        { error: err.message, createdId: err.createdId, partial: true },
        { status: 409 }
      );
    }
    if (err instanceof Error && !("status" in err)) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return errorResponse(err);
  }
}
