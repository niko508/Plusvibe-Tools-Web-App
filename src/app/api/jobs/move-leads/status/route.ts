import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { getJob } from "@/lib/jobs/move-leads";

export const dynamic = "force-dynamic";

// GET /api/jobs/move-leads/status?jobId=...
export async function GET(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const jobId = new URL(request.url).searchParams.get("jobId");
    if (!jobId) {
      return NextResponse.json({ error: "jobId is required" }, { status: 400 });
    }
    const job = await getJob(apiKey, jobId);
    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }
    return NextResponse.json(job);
  } catch (err) {
    return errorResponse(err);
  }
}
