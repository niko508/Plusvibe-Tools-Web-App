import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { isGroup, isPhase } from "@/lib/inbox-rotation/settings";
import { loadRotations, removeRotation, SettingsProblem, upsertRotation } from "@/lib/inbox-rotation/store";

export const dynamic = "force-dynamic";

// GET    /api/jobs/inbox-rotation/rotations   → { rotations }
// POST   /api/jobs/inbox-rotation/rotations   → { rotation }
//   Body: { workspaceId, workspaceName, startingGroup: 1 | 2, phase: "rampUp" | "maintaining" }
//   A workspace already set up is set up again, not listed twice.
// DELETE /api/jobs/inbox-rotation/rotations   → { ok }
//   Body: { id }
export async function GET(request: Request) {
  try {
    resolveApiKey(request);
    return NextResponse.json({ rotations: await loadRotations() });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    resolveApiKey(request);
    const body = (await request.json()) as {
      workspaceId?: unknown;
      workspaceName?: unknown;
      startingGroup?: unknown;
      phase?: unknown;
    };
    const group = typeof body.startingGroup === "string" ? Number(body.startingGroup) : body.startingGroup;
    if (!isGroup(group)) return NextResponse.json({ error: "Pick which sending group starts." }, { status: 400 });
    if (!isPhase(body.phase)) {
      return NextResponse.json({ error: "Pick the ramp-up period or the maintaining period." }, { status: 400 });
    }
    const rotation = await upsertRotation({
      workspaceId: String(body.workspaceId ?? "").trim(),
      workspaceName: String(body.workspaceName ?? "").trim(),
      startingGroup: group,
      phase: body.phase,
    });
    return NextResponse.json({ rotation });
  } catch (err) {
    if (err instanceof SettingsProblem) {
      return NextResponse.json({ error: err.problems.join(" ") }, { status: 400 });
    }
    return errorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    resolveApiKey(request);
    const body = (await request.json().catch(() => ({}))) as { id?: unknown };
    const id = String(body.id ?? "").trim();
    if (!id) return NextResponse.json({ error: "Which rotation?" }, { status: 400 });
    const ok = await removeRotation(id);
    if (!ok) return NextResponse.json({ error: "No such rotation." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
