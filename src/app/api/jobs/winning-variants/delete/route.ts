import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { deleteJob } from "@/lib/jobs/winning-variants";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const { jobId } = (await request.json().catch(() => ({}))) as { jobId?: string };
    if (!jobId) return NextResponse.json({ error: "jobId is required" }, { status: 400 });
    const ok = await deleteJob(apiKey, String(jobId));
    return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Run not found" }, { status: 404 });
  } catch (err) {
    return errorResponse(err);
  }
}
