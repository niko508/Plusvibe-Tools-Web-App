import { NextResponse } from "next/server";
import { burnedAccess } from "@/lib/burned/access";
import { errorResponse } from "@/lib/api-response";
import { ActiveJobError, RemovalProblem, createJob } from "@/lib/jobs/burned-removal";

export const dynamic = "force-dynamic";

// POST /api/jobs/burned-removal/start
// Body: { scanJobId, sheetUrl? }
//
// Records that scan's burned rows in the Email Infrastructure sheet, then
// deletes their inboxes in Plusvibe. Nothing is deleted until the sheet says
// it was written.
export async function POST(request: Request) {
  try {
    const { apiKey, who } = await burnedAccess(request);
    const body = (await request.json()) as { scanJobId?: unknown; sheetUrl?: unknown };
    const scanJobId = String(body.scanJobId ?? "").trim();
    if (!scanJobId) {
      return NextResponse.json({ error: "Which scan? Send its jobId." }, { status: 400 });
    }
    const sheetUrl = String(body.sheetUrl ?? "").trim() || undefined;
    const jobId = await createJob(apiKey, { scanJobId, sheetUrl }, { who });
    return NextResponse.json({ jobId });
  } catch (err) {
    if (err instanceof ActiveJobError) {
      return NextResponse.json({ error: err.message, activeJobId: err.activeJobId }, { status: 409 });
    }
    if (err instanceof RemovalProblem) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return errorResponse(err);
  }
}
