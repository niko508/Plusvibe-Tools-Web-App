import { NextResponse } from "next/server";
import { requireAccountKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { deleteFinishedSwitches } from "@/lib/jobs/outreach-schedule";

export const dynamic = "force-dynamic";

// POST /api/jobs/outreach-switch/clear-finished -> { removed }
// Removes every finished switch; waiting and running ones stay.
export async function POST(request: Request) {
  try {
    await requireAccountKey(request);
    return NextResponse.json({ removed: await deleteFinishedSwitches() });
  } catch (err) {
    return errorResponse(err);
  }
}
