import { NextResponse } from "next/server";
import { requireAccountKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { listSwitches } from "@/lib/jobs/outreach-schedule";

export const dynamic = "force-dynamic";

// GET /api/jobs/start-outreach/scheduled → { switches }
//
// Every booked week 2 switch, soonest first. Not scoped by key: a switch runs
// on the server's own key at six in the morning, so it belongs to the install
// rather than to whoever happens to be looking.
export async function GET(request: Request) {
  try {
    await requireAccountKey(request);
    return NextResponse.json({ switches: await listSwitches() });
  } catch (err) {
    return errorResponse(err);
  }
}
