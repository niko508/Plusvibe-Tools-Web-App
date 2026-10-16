import { NextResponse } from "next/server";
import { requireAccountKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { validateGeneralSettings } from "@/lib/general-settings/settings";
import { currentGeneralSettings, saveGeneralSettings } from "@/lib/general-settings/store";

export const dynamic = "force-dynamic";

// GET /api/general-settings -> { settings, updatedAt }   (updatedAt 0 = never saved)
export async function GET(request: Request) {
  try {
    await requireAccountKey(request);
    return NextResponse.json(await currentGeneralSettings());
  } catch (err) {
    return errorResponse(err);
  }
}

// PUT /api/general-settings  body: { settings }
// The page always sends every section. A section or field left out keeps its
// default, never the value saved before — so the page must send them all.
export async function PUT(request: Request) {
  try {
    await requireAccountKey(request);
    const body = (await request.json().catch(() => null)) as { settings?: unknown } | null;
    const { settings, problems } = validateGeneralSettings(body?.settings);
    if (!settings) return NextResponse.json({ error: problems.join(" "), problems }, { status: 400 });
    return NextResponse.json(await saveGeneralSettings(settings));
  } catch (err) {
    return errorResponse(err);
  }
}
