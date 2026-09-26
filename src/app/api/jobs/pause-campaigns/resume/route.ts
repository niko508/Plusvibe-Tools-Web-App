import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { resumeNow } from "@/lib/jobs/pause-campaigns";

export const dynamic = "force-dynamic";

// POST /api/jobs/pause-campaigns/resume  { jobId }
// Turns the job's paused campaigns back on now, using the caller's key.
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as { jobId?: string };
    if (!body.jobId) {
      return NextResponse.json({ error: "jobId is required" }, { status: 400 });
    }
    const result = await resumeNow(apiKey, body.jobId);
    if (result === "not-found") {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }
    if (result === "busy") {
      return NextResponse.json(
        { error: "This job is still working — wait for it to finish." },
        { status: 409 }
      );
    }
    if (result === "nothing-to-resume") {
      return NextResponse.json(
        { error: "This job has no paused campaigns left to resume." },
        { status: 409 }
      );
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
