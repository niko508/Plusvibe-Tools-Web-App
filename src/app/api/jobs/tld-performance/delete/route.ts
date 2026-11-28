import { NextResponse } from "next/server";
import { requireAccountKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { deleteReport } from "@/lib/jobs/tld-performance";

export const dynamic = "force-dynamic";

// POST /api/jobs/tld-performance/delete   Body: { id }
export async function POST(request: Request) {
  try {
    await requireAccountKey(request);
    const body = (await request.json().catch(() => ({}))) as { id?: unknown };
    return NextResponse.json({ ok: await deleteReport(String(body.id ?? "")) });
  } catch (err) {
    return errorResponse(err);
  }
}
