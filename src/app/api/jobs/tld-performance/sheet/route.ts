import { NextResponse } from "next/server";
import { requireAccountKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { TldSettingsProblem, resendToSheet } from "@/lib/jobs/tld-performance";

export const dynamic = "force-dynamic";

// POST /api/jobs/tld-performance/sheet   Body: { id }
//   Writes that report to the saved sheet again.
export async function POST(request: Request) {
  try {
    await requireAccountKey(request);
    const body = (await request.json().catch(() => ({}))) as { id?: unknown };
    const report = await resendToSheet(String(body.id ?? ""));
    if (!report) return NextResponse.json({ error: "That report has no tables to write." }, { status: 404 });
    return NextResponse.json({ sheet: report.sheet });
  } catch (err) {
    if (err instanceof TldSettingsProblem) return NextResponse.json({ error: err.message }, { status: 400 });
    return errorResponse(err);
  }
}
