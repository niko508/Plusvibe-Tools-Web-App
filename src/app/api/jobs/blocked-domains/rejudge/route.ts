import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { rejudgeAll, rejudgeJob } from "@/lib/jobs/blocked-domains";

export const dynamic = "force-dynamic";

// POST /api/jobs/blocked-domains/rejudge
// Body: { jobId } — re-judge one domain now, or { all: true } — every record,
// in the background. Neither changes anything in Plusvibe or the sheet.
export async function POST(request: Request) {
  try {
    resolveApiKey(request);
    const body = (await request.json()) as { jobId?: string; all?: boolean };
    if (body.all) {
      return NextResponse.json(await rejudgeAll());
    }
    if (!body.jobId) {
      return NextResponse.json({ error: "jobId is required" }, { status: 400 });
    }
    const ok = await rejudgeJob(body.jobId);
    if (!ok) {
      return NextResponse.json(
        { error: "Job not found, mid-run, or the re-judgement failed — see the card." },
        { status: 404 }
      );
    }
    return NextResponse.json({ ok });
  } catch (err) {
    return errorResponse(err);
  }
}
