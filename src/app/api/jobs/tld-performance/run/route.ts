import { NextResponse } from "next/server";
import { requireAccountKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { TldBusy, startReport } from "@/lib/jobs/tld-performance";
import { isMonth } from "@/lib/tld-performance/schedule";

export const dynamic = "force-dynamic";

// POST /api/jobs/tld-performance/run   Body: { month: "2026-10" }
//   Makes that month's report with the caller's key and answers at once; the
//   page follows it through GET /api/jobs/tld-performance.
export async function POST(request: Request) {
  try {
    const apiKey = await requireAccountKey(request);
    const body = (await request.json().catch(() => ({}))) as { month?: unknown };
    if (!isMonth(body.month)) return NextResponse.json({ error: "Pick a month." }, { status: 400 });
    await startReport(apiKey, body.month, "manual");
    return NextResponse.json({ started: true });
  } catch (err) {
    if (err instanceof TldBusy) return NextResponse.json({ error: err.message }, { status: 409 });
    return errorResponse(err);
  }
}
