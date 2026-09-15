import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { isDominant, parseLimit } from "@/lib/campaign-types/settings";
import { loadSettings, saveSettings, type SettingsPatch } from "@/lib/campaign-types/settings-store";

export const dynamic = "force-dynamic";

// GET /api/jobs/campaign-types/settings           → { settings }
// PUT /api/jobs/campaign-types/settings           → { settings }
//   Body: { dominant?, googleDailyLimit?, microsoftDailyLimit? }
//   Only the fields given change. A limit sent as null or "" is cleared, which
//   means the copies keep the limit they were duplicated with.
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
    const body = (await request.json()) as {
      dominant?: unknown;
      googleDailyLimit?: unknown;
      microsoftDailyLimit?: unknown;
    };
    const patch: SettingsPatch = {};

    if (body.dominant !== undefined) {
      if (!isDominant(body.dominant)) {
        return NextResponse.json({ error: 'Dominant targeting must be "google" or "microsoft".' }, { status: 400 });
      }
      patch.dominant = body.dominant;
    }
    for (const [key, label] of [
      ["googleDailyLimit", "Google daily limit"],
      ["microsoftDailyLimit", "Microsoft daily limit"],
    ] as const) {
      if (body[key] === undefined) continue;
      const p = parseLimit(body[key], label);
      if (p.error) return NextResponse.json({ error: p.error }, { status: 400 });
      patch[key] = p.value;
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
    }
    return NextResponse.json({ settings: await saveSettings(patch) });
  } catch (err) {
    return errorResponse(err);
  }
}
