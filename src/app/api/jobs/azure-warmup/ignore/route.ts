import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { addIgnored } from "@/lib/jobs/azure-warmup";

export const dynamic = "force-dynamic";

// POST /api/jobs/azure-warmup/ignore  body: { jobId, emails: string[] }
// Drops inboxes from a run that's already going, for addresses that errored on
// the provisioning side and are never going to appear.
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as {
      jobId?: string;
      emails?: string[];
    };
    if (!body.jobId) {
      return NextResponse.json({ error: "jobId is required" }, { status: 400 });
    }
    const emails = Array.isArray(body.emails) ? body.emails.map(String) : [];
    if (emails.length === 0) {
      return NextResponse.json(
        { error: "Paste at least one email address." },
        { status: 400 }
      );
    }
    const removed = await addIgnored(apiKey, body.jobId, emails);
    if (removed < 0) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }
    return NextResponse.json({ removed });
  } catch (err) {
    return errorResponse(err);
  }
}
