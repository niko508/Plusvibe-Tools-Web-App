import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { runRecheck, setRecheck } from "@/lib/jobs/blocked-domains";

export const dynamic = "force-dynamic";

// POST /api/jobs/blocked-domains/recheck
// Body: { jobId, action: "now" | "on" | "off" }
//
// "now" runs the repeat assessment immediately; the other two arm or disarm
// the schedule for that one domain.
export async function POST(request: Request) {
  try {
    resolveApiKey(request);
    const body = (await request.json()) as { jobId?: string; action?: string };
    if (!body.jobId) {
      return NextResponse.json({ error: "jobId is required" }, { status: 400 });
    }
    const action = body.action ?? "now";
    if (!["now", "on", "off"].includes(action)) {
      return NextResponse.json({ error: 'action must be "now", "on" or "off"' }, { status: 400 });
    }
    const ok =
      action === "now"
        ? await runRecheck(body.jobId, "manual")
        : await setRecheck(body.jobId, action === "on");
    if (!ok) {
      return NextResponse.json(
        { error: "Job not found, or it is mid-run and can't be re-checked right now." },
        { status: 404 }
      );
    }
    return NextResponse.json({ ok });
  } catch (err) {
    return errorResponse(err);
  }
}
