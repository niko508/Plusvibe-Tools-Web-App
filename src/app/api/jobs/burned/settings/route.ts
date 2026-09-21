import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { loadSettings, saveSettings, SettingsProblem } from "@/lib/burned/store";

export const dynamic = "force-dynamic";

// GET /api/jobs/burned/settings  → { settings }
// PUT /api/jobs/burned/settings  → { settings }
//   Body: { google?: { minSends, replyOooPct }, microsoft?: { … } }
//   The provider left out keeps what it had.
export async function GET(request: Request) {
  try {
    resolveApiKey(request);
    return NextResponse.json({ settings: await loadSettings() });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    resolveApiKey(request);
    const body = (await request.json()) as Record<string, unknown>;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Send the thresholds to save." }, { status: 400 });
    }
    return NextResponse.json({ settings: await saveSettings(body) });
  } catch (err) {
    if (err instanceof SettingsProblem) {
      return NextResponse.json({ error: err.problems.join(" "), problems: err.problems }, { status: 400 });
    }
    return errorResponse(err);
  }
}
