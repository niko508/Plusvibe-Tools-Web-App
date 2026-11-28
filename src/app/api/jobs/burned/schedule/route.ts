import { NextResponse } from "next/server";
import { requireAccountKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { skipNextRun, status } from "@/lib/jobs/burned-schedule";

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

// POST /api/jobs/burned/schedule { skipNext: boolean } → WeeklyStatus
//   Skips the next Monday's run, or takes the skip back.
export async function POST(request: Request) {
  try {
    await requireAccountKey(request);
    const body = (await request.json().catch(() => ({}))) as { skipNext?: unknown };
    if (typeof body.skipNext !== "boolean") return NextResponse.json({ error: "Send { skipNext: true | false }." }, { status: 400 });
    return NextResponse.json(await skipNextRun(body.skipNext));
  } catch (err) {
    return errorResponse(err);
  }
}
