import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { confirmJob } from "@/lib/jobs/copy-replace";

export const dynamic = "force-dynamic";

// POST /api/jobs/copy-replace/confirm  { jobId }
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as { jobId?: string };
    if (!body.jobId) return NextResponse.json({ error: "jobId is required" }, { status: 400 });
    const result = await confirmJob(apiKey, body.jobId);
    if (result === "not-found") return NextResponse.json({ error: "Job not found" }, { status: 404 });
    if (result === "not-waiting") return NextResponse.json({ error: "This job is not waiting for confirmation." }, { status: 409 });
    if (result === "nothing") return NextResponse.json({ error: "Nothing would change, so there is nothing to apply." }, { status: 409 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
