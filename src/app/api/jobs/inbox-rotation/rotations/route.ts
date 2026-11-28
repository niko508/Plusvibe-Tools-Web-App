import { NextResponse } from "next/server";
import { requireAccountKey, resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { isGroup, isStage, isYmd, type ProfileKey } from "@/lib/inbox-rotation/settings";
import { todayIn, type Position } from "@/lib/inbox-rotation/schedule";
import { loadRotations, removeRotation, SettingsProblem, upsertRotation } from "@/lib/inbox-rotation/store";
import { applyRotation, isRunning, positionsFor, serverApiKey } from "@/lib/inbox-rotation/runner";

export const dynamic = "force-dynamic";

// GET    /api/jobs/inbox-rotation/rotations
//   → { rotations: [{ …rotation, running, positions }], today, serverKey }
//   `positions` is where each profile stands today; `serverKey` says whether
//   the server can apply switches on its own (PLUSVIBE_API_KEY is set).
// POST   /api/jobs/inbox-rotation/rotations   → { rotation }
//   Body: { workspaceId, workspaceName, startingGroup: 1 | 2,
//           startDate: "YYYY-MM-DD", stage: 1…5 | "maintaining" }
//   A workspace already set up is set up again, not listed twice. Today's
//   settings are applied straight away with the caller's key.
// DELETE /api/jobs/inbox-rotation/rotations   → { ok }
//   Body: { id }
export async function GET(request: Request) {
  try {
    await requireAccountKey(request);
    const today = todayIn();
    const out = [];
    for (const rec of await loadRotations()) {
      const { positions, rec: withPicks } = await positionsFor(rec, today);
      out.push({ ...withPicks, running: isRunning(rec.id), positions: positions as Partial<Record<ProfileKey, Position>> });
    }
    return NextResponse.json({ rotations: out, today, serverKey: !!serverApiKey() });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as {
      workspaceId?: unknown;
      workspaceName?: unknown;
      startingGroup?: unknown;
      startDate?: unknown;
      stage?: unknown;
    };
    const group = typeof body.startingGroup === "string" ? Number(body.startingGroup) : body.startingGroup;
    if (!isGroup(group)) return NextResponse.json({ error: "Pick which sending group starts." }, { status: 400 });
    if (!isYmd(body.startDate)) return NextResponse.json({ error: "Pick a start date." }, { status: 400 });
    const stage = typeof body.stage === "string" && body.stage !== "maintaining" ? Number(body.stage) : body.stage;
    if (!isStage(stage)) return NextResponse.json({ error: "Pick the stage to start on." }, { status: 400 });
    const rotation = await upsertRotation({
      workspaceId: String(body.workspaceId ?? "").trim(),
      workspaceName: String(body.workspaceName ?? "").trim(),
      startingGroup: group,
      startDate: body.startDate,
      stage,
    });
    // Today's settings, now, with the key that set it up — the page polls
    // for the outcome. The scheduler carries on from here with its own key.
    void applyRotation(rotation.id, apiKey, { trigger: "setup" });
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
    await requireAccountKey(request);
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
