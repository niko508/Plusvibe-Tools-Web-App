import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { loadSettings, saveSettings } from "@/lib/blocked-domains/settings";

export const dynamic = "force-dynamic";

// PUT /api/jobs/blocked-domains/settings
// Body: { autoDelete?, checkPerformance?, minReplyRateOoo?, minDomainReplyRateOoo? }
// Only the fields given are changed.
export async function PUT(request: Request) {
  try {
    resolveApiKey(request);
    const body = (await request.json()) as {
      autoDelete?: unknown;
      checkPerformance?: unknown;
      minReplyRateOoo?: unknown;
      minDomainReplyRateOoo?: unknown;
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
    for (const key of ["minReplyRateOoo", "minDomainReplyRateOoo"] as const) {
      const raw = body[key];
      if (raw === undefined) continue;
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        return NextResponse.json(
          { error: `${key} must be a percentage between 0 and 100` },
          { status: 400 }
        );
      }
      patch[key] = n;
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
