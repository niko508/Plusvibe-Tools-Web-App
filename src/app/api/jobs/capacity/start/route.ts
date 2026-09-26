import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { ActiveJobError, createJob } from "@/lib/jobs/capacity";

export const dynamic = "force-dynamic";

// POST /api/jobs/capacity/start
//
// Counts every workspace's inboxes by what they run on. Reads only; it takes
// no body, because there is nothing to choose.
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const jobId = await createJob(apiKey);
    return NextResponse.json({ jobId });
  } catch (err) {
    if (err instanceof ActiveJobError) {
      return NextResponse.json({ error: err.message, activeJobId: err.activeJobId }, { status: 409 });
    }
    return errorResponse(err);
  }
}
