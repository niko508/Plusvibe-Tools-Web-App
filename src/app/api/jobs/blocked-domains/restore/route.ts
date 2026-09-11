import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { restoreInboxes } from "@/lib/jobs/blocked-domains";

export const dynamic = "force-dynamic";

// POST /api/jobs/blocked-domains/restore
// Body: { jobId, dailyLimit }
//
// Turns the inboxes the last re-judgement marked restorable back on. Only
// those: it never touches an inbox the re-judgement left under the bar.
export async function POST(request: Request) {
  try {
    resolveApiKey(request);
    const body = (await request.json()) as { jobId?: string; dailyLimit?: unknown };
    if (!body.jobId) {
      return NextResponse.json({ error: "jobId is required" }, { status: 400 });
    }
    const res = await restoreInboxes(body.jobId, body.dailyLimit);
    if (!res.ok) {
      return NextResponse.json({ error: res.error ?? "Could not restore." }, { status: 400 });
    }
    return NextResponse.json(res);
  } catch (err) {
    return errorResponse(err);
  }
}
