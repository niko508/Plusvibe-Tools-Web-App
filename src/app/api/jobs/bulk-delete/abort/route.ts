import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { abortJob } from "@/lib/jobs/bulk-delete";

export const dynamic = "force-dynamic";

// POST /api/jobs/bulk-delete/abort  body: { jobId }
// Signals a running job to stop; in-flight deletes finish, no new ones start.
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json().catch(() => ({}))) as {
      jobId?: string;
    };
    if (!body.jobId) {
      return NextResponse.json({ error: "jobId is required" }, { status: 400 });
    }
    const ok = await abortJob(apiKey, body.jobId);
    return NextResponse.json({ ok });
  } catch (err) {
    return errorResponse(err);
  }
}
