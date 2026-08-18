import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { listJobs } from "@/lib/jobs/move-leads";

export const dynamic = "force-dynamic";

// GET /api/jobs/move-leads/list — jobs for the calling API key, newest first.
export async function GET(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    return NextResponse.json({ jobs: await listJobs(apiKey) });
  } catch (err) {
    return errorResponse(err);
  }
}
