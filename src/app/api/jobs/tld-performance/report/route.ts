import { NextResponse } from "next/server";
import { requireAccountKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { getReport } from "@/lib/jobs/tld-performance";

export const dynamic = "force-dynamic";

// GET /api/jobs/tld-performance/report?id=… → { report } with its tables.
export async function GET(request: Request) {
  try {
    await requireAccountKey(request);
    const id = new URL(request.url).searchParams.get("id") ?? "";
    const report = await getReport(id);
    if (!report) return NextResponse.json({ error: "That report is no longer here." }, { status: 404 });
    return NextResponse.json({ report });
  } catch (err) {
    return errorResponse(err);
  }
}
