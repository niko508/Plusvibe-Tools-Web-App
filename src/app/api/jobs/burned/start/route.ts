import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { ActiveJobError, createJob } from "@/lib/jobs/burned";
import { isEsp } from "@/lib/burned/settings";
import { rangeProblem } from "@/lib/inbox-performance/metrics";

export const dynamic = "force-dynamic";

// POST /api/jobs/burned/start
// Body: { esp: "google" | "microsoft", start, end }
//
// Scans every workspace on the key. The thresholds are the saved ones for
// that provider, read when the job starts.
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as { esp?: unknown; start?: unknown; end?: unknown };

    if (!isEsp(body.esp)) {
      return NextResponse.json({ error: "Pick Google or Microsoft." }, { status: 400 });
    }
    const start = String(body.start ?? "").trim();
    const end = String(body.end ?? "").trim();
    // The bulk stats endpoint refuses a range longer than 90 days, and the
    // scan is built on it, so the same rule is applied before anything runs.
    const problem = rangeProblem(start, end);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });

    const jobId = await createJob(apiKey, { esp: body.esp, start, end });
    return NextResponse.json({ jobId });
  } catch (err) {
    if (err instanceof ActiveJobError) {
      return NextResponse.json({ error: err.message, activeJobId: err.activeJobId }, { status: 409 });
    }
    return errorResponse(err);
  }
}
