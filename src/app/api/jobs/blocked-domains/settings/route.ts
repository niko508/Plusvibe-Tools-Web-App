import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { loadSettings, saveSettings } from "@/lib/blocked-domains/settings";

export const dynamic = "force-dynamic";

// PUT /api/jobs/blocked-domains/settings  Body: { autoDelete: boolean }
export async function PUT(request: Request) {
  try {
    resolveApiKey(request);
    const body = (await request.json()) as { autoDelete?: unknown };
    if (typeof body.autoDelete !== "boolean") {
      return NextResponse.json(
        { error: "autoDelete must be true or false" },
        { status: 400 }
      );
    }
    const settings = await saveSettings(body.autoDelete);
    return NextResponse.json({ settings });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function GET(request: Request) {
  try {
    resolveApiKey(request);
    return NextResponse.json({ settings: await loadSettings() });
  } catch (err) {
    return errorResponse(err);
  }
}
