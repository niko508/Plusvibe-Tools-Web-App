import { NextResponse } from "next/server";
import { requireAccountKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { AutoOutreachProblem, startAutomatedOutreach } from "@/lib/start-outreach/auto";

export const dynamic = "force-dynamic";

// POST /api/jobs/start-outreach/auto
// Body: { sourceWorkspaceId, destWorkspaceId, domains: string[] }
//
// Starts a Start Outreach run for every inbox on those domains in the source
// workspace, with the saved week 1 / week 2 settings, signatures, tags and
// sheet update the page would use. Called by Outengine Bulk Actions' Replace
// Domains (Automated) with the account's Plusvibe key (x-pv-key). The run is
// the page's own: it shows on the Start Outreach page and books week 2.
export async function POST(request: Request) {
  try {
    const apiKey = await requireAccountKey(request);
    const body = (await request.json().catch(() => ({}))) as {
      sourceWorkspaceId?: unknown;
      destWorkspaceId?: unknown;
      domains?: unknown;
    };
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const domains = (Array.isArray(body.domains) ? body.domains : []).map(str).filter(Boolean).slice(0, 200);
    const result = await startAutomatedOutreach(apiKey, {
      sourceWorkspaceId: str(body.sourceWorkspaceId),
      destWorkspaceId: str(body.destWorkspaceId),
      domains,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof AutoOutreachProblem) return NextResponse.json({ error: err.message }, { status: 400 });
    // createJob refuses a batch that can't work with a plain Error.
    if (err instanceof Error && !("status" in err)) return NextResponse.json({ error: err.message }, { status: 400 });
    return errorResponse(err);
  }
}
