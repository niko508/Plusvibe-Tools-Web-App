import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { runNow } from "@/lib/jobs/outreach-schedule";

export const dynamic = "force-dynamic";

// POST /api/jobs/outreach-switch/run-now  { id }
//
// Applies a booked switch immediately instead of waiting for its morning, with
// the browser's key rather than the server's — this one has someone watching.
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as { id?: string };
    if (!body.id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    const ok = await runNow(body.id, apiKey);
    if (!ok) return NextResponse.json({ error: "That switch is not waiting to run." }, { status: 404 });
    return NextResponse.json({ ok });
  } catch (err) {
    return errorResponse(err);
  }
}
