import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { QueueRejectedError, resumeJob } from "@/lib/jobs/campaign-types";

export const dynamic = "force-dynamic";

// POST /api/jobs/campaign-types/resume  { jobId }
//
// Continues a run a restart cut off, as a new run that carries what the old
// one already moved. Safe to call twice: the second call gets the same run.
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as { jobId?: string };
    if (!body.jobId) return NextResponse.json({ error: "jobId is required" }, { status: 400 });
    const jobId = await resumeJob(apiKey, body.jobId);
    return NextResponse.json({ jobId });
  } catch (err) {
    if (err instanceof QueueRejectedError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return errorResponse(err);
  }
}
