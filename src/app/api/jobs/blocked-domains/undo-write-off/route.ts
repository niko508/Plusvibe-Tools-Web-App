import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { undoWriteOff } from "@/lib/jobs/blocked-domains";

export const dynamic = "force-dynamic";

// POST /api/jobs/blocked-domains/undo-write-off
// Body: { jobId }
//
// Puts the Domains row's Status back to what it was and returns the record
// to "kept". Rows appended to the cancel tabs are named for a person to
// remove; they are not touched.
export async function POST(request: Request) {
  try {
    resolveApiKey(request);
    const body = (await request.json()) as { jobId?: string };
    if (!body.jobId) {
      return NextResponse.json({ error: "jobId is required" }, { status: 400 });
    }
    const res = await undoWriteOff(body.jobId);
    if (!res.ok) {
      return NextResponse.json({ error: res.error ?? "Could not undo." }, { status: 400 });
    }
    return NextResponse.json(res);
  } catch (err) {
    return errorResponse(err);
  }
}
