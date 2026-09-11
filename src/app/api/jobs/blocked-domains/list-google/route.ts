import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { listGoogleInboxesForJob } from "@/lib/jobs/blocked-domains";

export const dynamic = "force-dynamic";

// POST /api/jobs/blocked-domains/list-google
// Body: { jobId }
//
// Lists a Google domain's burned inboxes on 🛑 Google Inboxes to Cancel when
// the run itself did not — one handled before the Google path existed.
export async function POST(request: Request) {
  try {
    resolveApiKey(request);
    const body = (await request.json()) as { jobId?: string };
    if (!body.jobId) {
      return NextResponse.json({ error: "jobId is required" }, { status: 400 });
    }
    const res = await listGoogleInboxesForJob(body.jobId);
    if (!res.ok) {
      return NextResponse.json({ error: res.error ?? "Could not list." }, { status: 400 });
    }
    return NextResponse.json(res);
  } catch (err) {
    return errorResponse(err);
  }
}
