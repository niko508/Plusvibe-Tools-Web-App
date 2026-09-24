import { NextResponse } from "next/server";
import { requireAccountKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { cancelSwitch } from "@/lib/jobs/outreach-schedule";

export const dynamic = "force-dynamic";

// POST /api/jobs/outreach-switch/cancel  { id }
export async function POST(request: Request) {
  try {
    await requireAccountKey(request);
    const body = (await request.json()) as { id?: string };
    if (!body.id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    const ok = await cancelSwitch(body.id);
    if (!ok) return NextResponse.json({ error: "That switch is not there, or is already running." }, { status: 404 });
    return NextResponse.json({ ok });
  } catch (err) {
    return errorResponse(err);
  }
}
