import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { cloneWithWinners, NeedsConfirmError, PartialCloneError } from "@/lib/winning-variants/run";
import { planProblems } from "@/lib/winning-variants/plan";

export const dynamic = "force-dynamic";

// POST /api/winning-variants/run
// { workspaceId, campaignId, name, tagIds, newTags, confirmEmpty }
// Duplicates the campaign in its own workspace, keeps only step 1's winning
// variants, sets the clone's tags, and reads it back.
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json().catch(() => ({}))) as {
      workspaceId?: string;
      campaignId?: string;
      name?: string;
      tagIds?: unknown;
      newTags?: unknown;
      confirmEmpty?: boolean;
    };
    const sel = { workspaceId: String(body.workspaceId ?? ""), campaignId: String(body.campaignId ?? ""), name: String(body.name ?? "") };
    // Checked again here: this is the last stop before a campaign is created.
    const problems = planProblems(sel);
    if (problems.length > 0) return NextResponse.json({ error: problems[0] }, { status: 400 });
    const strings = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x ?? "")).filter(Boolean).slice(0, 50) : []);
    const result = await cloneWithWinners({
      apiKey,
      ...sel,
      tagIds: strings(body.tagIds),
      newTags: strings(body.newTags),
      confirmEmpty: body.confirmEmpty === true,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof NeedsConfirmError) return NextResponse.json({ error: err.message, needsConfirm: true }, { status: 409 });
    if (err instanceof PartialCloneError) return NextResponse.json({ error: err.message, createdId: err.createdId, partial: true }, { status: 409 });
    if (err instanceof Error && !("status" in err)) return NextResponse.json({ error: err.message }, { status: 400 });
    return errorResponse(err);
  }
}
