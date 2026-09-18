import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { listJobs } from "@/lib/jobs/remove-50";

export const dynamic = "force-dynamic";

// GET /api/jobs/remove-50/list
// Lists jobs belonging to the calling API key's fingerprint, newest first.
export async function GET(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const jobs = await listJobs(apiKey);
    return NextResponse.json({ jobs });
  } catch (err) {
    return errorResponse(err);
  }
}
