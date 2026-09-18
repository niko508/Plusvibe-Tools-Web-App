import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { rearmJob } from "@/lib/jobs/blocked-domains";

export const dynamic = "force-dynamic";

// POST /api/jobs/blocked-domains/rearm  Body: { jobId }
// Lets the domain trigger again while keeping this run in the history.
export async function POST(request: Request) {
  try {
    resolveApiKey(request);
    const body = (await request.json()) as { jobId?: string };
    if (!body.jobId) {
      return NextResponse.json({ error: "jobId is required" }, { status: 400 });
    }
    const ok = await rearmJob(body.jobId);
    if (!ok) {
      return NextResponse.json(
        {
          error:
            "Not found, already re-armed, or still running — finish or stop it first.",
        },
        { status: 404 }
      );
    }
    return NextResponse.json({ ok });
  } catch (err) {
    return errorResponse(err);
  }
}
