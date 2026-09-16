import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { isYmd } from "@/lib/inbox-rotation/settings";
import { loadRotations } from "@/lib/inbox-rotation/store";
import { applyRotation, isRunning } from "@/lib/inbox-rotation/runner";

export const dynamic = "force-dynamic";

// POST /api/jobs/inbox-rotation/apply   → { ok, running }
//   Body: { id, force? }
//   Re-reads the workspace and writes today's settings with the caller's key.
//   `force` writes the current segment again even if it was written before.
//   `asOf` (a YYYY-MM-DD) is honoured only when INBOX_ROTATION_ALLOW_AS_OF is
//   set — it exists for the stand-in checks, never for production.
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json().catch(() => ({}))) as { id?: unknown; force?: unknown; asOf?: unknown; wait?: unknown };
    const id = String(body.id ?? "").trim();
    if (!id) return NextResponse.json({ error: "Which rotation?" }, { status: 400 });
    if (!(await loadRotations()).some((r) => r.id === id)) {
      return NextResponse.json({ error: "No such rotation." }, { status: 404 });
    }
    const asOf = process.env.INBOX_ROTATION_ALLOW_AS_OF === "1" && isYmd(body.asOf) ? body.asOf : undefined;
    const run = applyRotation(id, apiKey, { trigger: "manual", force: body.force === true, asOf });
    if (body.wait === true) {
      const rotation = await run;
      return NextResponse.json({ ok: true, running: false, rotation });
    }
    void run;
    return NextResponse.json({ ok: true, running: isRunning(id) });
  } catch (err) {
    return errorResponse(err);
  }
}
