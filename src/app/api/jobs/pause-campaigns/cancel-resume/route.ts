import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { cancelResume } from "@/lib/jobs/pause-campaigns";

export const dynamic = "force-dynamic";

// POST /api/jobs/pause-campaigns/cancel-resume  { jobId }
// Drops the scheduled resume. The campaigns stay paused.
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as { jobId?: string };
    if (!body.jobId) {
      return NextResponse.json({ error: "jobId is required" }, { status: 400 });
    }
    const ok = await cancelResume(apiKey, body.jobId);
    if (!ok) {
      return NextResponse.json(
        { error: "No scheduled resume to cancel on that job." },
        { status: 404 }
      );
    }
    return NextResponse.json({ ok });
  } catch (err) {
    return errorResponse(err);
  }
}
