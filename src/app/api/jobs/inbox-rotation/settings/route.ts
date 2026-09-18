import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { loadSettings, saveSettings, SettingsProblem } from "@/lib/inbox-rotation/store";

export const dynamic = "force-dynamic";

// GET /api/jobs/inbox-rotation/settings              → { settings }
// PUT /api/jobs/inbox-rotation/settings              → { settings }
//   Body: { profiles: { azure50?, azure25?, google? } }, each a full profile
//   (five cycles and the maintaining period). Profiles left out are kept.
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
    const body = (await request.json()) as { profiles?: unknown };
    if (!body.profiles || typeof body.profiles !== "object") {
      return NextResponse.json({ error: "Send the profiles to save." }, { status: 400 });
    }
    const settings = await saveSettings(body.profiles as Record<string, unknown>);
    return NextResponse.json({ settings });
  } catch (err) {
    if (err instanceof SettingsProblem) {
      return NextResponse.json({ error: err.problems.join(" "), problems: err.problems }, { status: 400 });
    }
    return errorResponse(err);
  }
}
