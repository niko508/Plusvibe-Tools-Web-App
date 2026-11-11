import { NextResponse } from "next/server";
import { requireAccountKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { status } from "@/lib/jobs/burned-schedule";

export const dynamic = "force-dynamic";

// GET /api/jobs/burned/schedule → WeeklyStatus
//   The weekly run's settings, when it runs next, and how the last one went.
//   Change the settings through PUT /api/jobs/burned/settings { schedule }.
export async function GET(request: Request) {
  try {
    await requireAccountKey(request);
    return NextResponse.json(await status());
  } catch (err) {
    return errorResponse(err);
  }
}
