import { NextResponse } from "next/server";
import { requireAccountKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { status } from "@/lib/jobs/tld-performance";

export const dynamic = "force-dynamic";

// GET /api/jobs/tld-performance → TldStatus
//   The settings, the monthly schedule and every report (without its tables).
export async function GET(request: Request) {
  try {
    await requireAccountKey(request);
    return NextResponse.json(await status());
  } catch (err) {
    return errorResponse(err);
  }
}
