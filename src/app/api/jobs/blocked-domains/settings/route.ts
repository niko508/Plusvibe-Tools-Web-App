import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { loadSettings, saveSettings } from "@/lib/blocked-domains/settings";

export const dynamic = "force-dynamic";

// PUT /api/jobs/blocked-domains/settings
// Body: { autoDelete?: boolean, checkPerformance?: boolean, minReplyRateOoo?: number }
// Only the fields given are changed.
export async function PUT(request: Request) {
  try {
    resolveApiKey(request);
    const body = (await request.json()) as {
      autoDelete?: unknown;
      checkPerformance?: unknown;
      minReplyRateOoo?: unknown;
    };
    const patch: Parameters<typeof saveSettings>[0] = {};

    if (body.autoDelete !== undefined) {
      if (typeof body.autoDelete !== "boolean") {
        return NextResponse.json({ error: "autoDelete must be true or false" }, { status: 400 });
      }
      patch.autoDelete = body.autoDelete;
    }
    if (body.checkPerformance !== undefined) {
      if (typeof body.checkPerformance !== "boolean") {
        return NextResponse.json({ error: "checkPerformance must be true or false" }, { status: 400 });
      }
      patch.checkPerformance = body.checkPerformance;
    }
    if (body.minReplyRateOoo !== undefined) {
      const n = typeof body.minReplyRateOoo === "number" ? body.minReplyRateOoo : Number(body.minReplyRateOoo);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        return NextResponse.json(
          { error: "minReplyRateOoo must be a percentage between 0 and 100" },
          { status: 400 }
        );
      }
      patch.minReplyRateOoo = n;
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
    }
    return NextResponse.json({ settings: await saveSettings(patch) });
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
