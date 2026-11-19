import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { resumeJob } from "@/lib/jobs/azure-warmup";

export const dynamic = "force-dynamic";

// POST /api/jobs/azure-warmup/resume  body: { jobId }
// A run can span days, so a redeploy will interrupt it. Everything needed to
// continue is persisted; this restarts the runner with a fresh API key and
// skips the inboxes already warmed.
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as { jobId?: string };
    if (!body.jobId) {
      return NextResponse.json({ error: "jobId is required" }, { status: 400 });
    }
    const ok = await resumeJob(apiKey, body.jobId);
    if (!ok) {
      return NextResponse.json(
        { error: "That job can't be resumed (already finished, or not yours)." },
        { status: 400 }
      );
    }
    return NextResponse.json({ ok });
  } catch (err) {
    return errorResponse(err);
  }
}
