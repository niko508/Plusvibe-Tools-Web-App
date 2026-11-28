import { NextResponse } from "next/server";
import { requireAccountKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { loadWarmupSettings, saveWarmupSettings } from "@/lib/azure-warmup/settings-store";
import { DEFAULT_WARMUP_SETTINGS, validateWarmupSettings } from "@/lib/azure-warmup/warmup-settings";

export const dynamic = "force-dynamic";

// GET  /api/jobs/azure-warmup/settings → { settings, updatedAt, defaults }
// PUT  /api/jobs/azure-warmup/settings   body: the whole settings object
//
// Every new run takes a copy of what is saved here when it starts.
export async function GET(request: Request) {
  try {
    await requireAccountKey(request);
    const stored = await loadWarmupSettings();
    return NextResponse.json({ ...stored, defaults: DEFAULT_WARMUP_SETTINGS });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    await requireAccountKey(request);
    const body = await request.json().catch(() => null);
    const { settings, problems } = validateWarmupSettings(body);
    if (!settings) return NextResponse.json({ error: problems.join(" "), problems }, { status: 400 });
    const stored = await saveWarmupSettings(settings);
    return NextResponse.json({ ...stored, defaults: DEFAULT_WARMUP_SETTINGS });
  } catch (err) {
    return errorResponse(err);
  }
}
