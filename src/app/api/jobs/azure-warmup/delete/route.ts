import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { deleteJob } from "@/lib/jobs/azure-warmup";

export const dynamic = "force-dynamic";

// POST /api/jobs/azure-warmup/delete  body: { jobId }
// Removes a job and its stored record. A running job is stopped first.
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as { jobId?: string };
    if (!body.jobId) {
      return NextResponse.json({ error: "jobId is required" }, { status: 400 });
    }
    const ok = await deleteJob(apiKey, body.jobId);
    if (!ok) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }
    return NextResponse.json({ ok });
  } catch (err) {
    return errorResponse(err);
  }
}
