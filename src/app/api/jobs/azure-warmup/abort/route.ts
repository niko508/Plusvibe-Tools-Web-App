import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { abortJob } from "@/lib/jobs/azure-warmup";

export const dynamic = "force-dynamic";

// POST /api/jobs/azure-warmup/abort  body: { jobId }
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as { jobId?: string };
    if (!body.jobId) {
      return NextResponse.json({ error: "jobId is required" }, { status: 400 });
    }
    return NextResponse.json({ ok: await abortJob(apiKey, body.jobId) });
  } catch (err) {
    return errorResponse(err);
  }
}
