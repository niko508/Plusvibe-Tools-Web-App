import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { confirmJob } from "@/lib/jobs/blocked-domains";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    resolveApiKey(request);
    const body = (await request.json()) as { jobId?: string };
    if (!body.jobId) {
      return NextResponse.json({ error: "jobId is required" }, { status: 400 });
    }
    const ok = await confirmJob(body.jobId);
    if (!ok) {
      return NextResponse.json(
        { error: "Not found, or no longer in a state that allows this." },
        { status: 404 }
      );
    }
    return NextResponse.json({ ok });
  } catch (err) {
    return errorResponse(err);
  }
}
