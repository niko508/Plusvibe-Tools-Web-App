import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { deleteStoppedInboxes } from "@/lib/jobs/blocked-domains";

export const dynamic = "force-dynamic";

// POST /api/jobs/blocked-domains/delete-stopped
// Body: { jobId }
//
// Deletes the inboxes this automation stopped on a domain that is not already
// waiting on a deletion. Never the sending ones, never the sheet.
export async function POST(request: Request) {
  try {
    resolveApiKey(request);
    const body = (await request.json()) as { jobId?: string };
    if (!body.jobId) {
      return NextResponse.json({ error: "jobId is required" }, { status: 400 });
    }
    const res = await deleteStoppedInboxes(body.jobId);
    if (!res.ok) {
      return NextResponse.json({ error: res.error ?? "Could not delete." }, { status: 400 });
    }
    return NextResponse.json(res);
  } catch (err) {
    return errorResponse(err);
  }
}
