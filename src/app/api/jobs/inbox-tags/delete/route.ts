import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { deleteJob } from "@/lib/jobs/inbox-tags";

export const dynamic = "force-dynamic";

// POST /api/jobs/inbox-tags/delete  { jobId }
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as { jobId?: string };
    if (!body.jobId) return NextResponse.json({ error: "jobId is required" }, { status: 400 });
    const ok = await deleteJob(apiKey, body.jobId);
    if (!ok) return NextResponse.json({ error: "Job not found or not in a state for this." }, { status: 404 });
    return NextResponse.json({ ok });
  } catch (err) {
    return errorResponse(err);
  }
}
