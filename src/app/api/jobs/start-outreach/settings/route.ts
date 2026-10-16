import { NextResponse } from "next/server";
import { requireAccountKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { loadSettings, saveSettings, SettingsProblem } from "@/lib/start-outreach/store";

export const dynamic = "force-dynamic";

// GET  /api/jobs/start-outreach/settings  → { settings }
// PUT  /api/jobs/start-outreach/settings  → { settings }
//   Body: { google: { week1, week2 }, azure25: {…}, azure50: {…} }
//
// Saved on the server rather than in the browser because the scheduled week 2
// switch reads them with nobody watching.
export async function GET(request: Request) {
  try {
    await requireAccountKey(request);
    return NextResponse.json({ settings: await loadSettings() });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    await requireAccountKey(request);
    const body = (await request.json()) as unknown;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Send the settings to save." }, { status: 400 });
    }
    return NextResponse.json({ settings: await saveSettings(body) });
  } catch (err) {
    if (err instanceof SettingsProblem) {
      return NextResponse.json({ error: err.problems.join(" "), problems: err.problems }, { status: 400 });
    }
    return errorResponse(err);
  }
}
