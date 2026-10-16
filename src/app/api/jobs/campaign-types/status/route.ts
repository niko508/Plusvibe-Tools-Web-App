import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { getJob } from "@/lib/jobs/campaign-types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const id = new URL(request.url).searchParams.get("jobId") ?? "";
    if (!id) {
      return NextResponse.json({ error: "jobId is required" }, { status: 400 });
    }
    const job = await getJob(apiKey, id);
    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }
    return NextResponse.json({ job });
  } catch (err) {
    return errorResponse(err);
  }
}
