import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { MAX_RECHECK_DAYS, loadSettings, saveSettings } from "@/lib/blocked-domains/settings";
import { applyRecheckInterval } from "@/lib/jobs/blocked-domains";

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
      recheck?: unknown;
      recheckDays?: unknown;
    };
    const patch: Parameters<typeof saveSettings>[0] = {};

    if (body.autoDelete !== undefined) {
      if (typeof body.autoDelete !== "boolean") {
        return NextResponse.json({ error: "autoDelete must be true or false" }, { status: 400 });
      }
      patch.autoDelete = body.autoDelete;
    }
    for (const key of ["checkPerformance", "recheck"] as const) {
      const raw = body[key];
      if (raw === undefined) continue;
      if (typeof raw !== "boolean") {
        return NextResponse.json({ error: `${key} must be true or false` }, { status: 400 });
      }
      patch[key] = raw;
    }
    if (body.recheckDays !== undefined) {
      const n = typeof body.recheckDays === "number" ? body.recheckDays : Number(body.recheckDays);
      if (!Number.isInteger(n) || n < 1 || n > MAX_RECHECK_DAYS) {
        return NextResponse.json(
          { error: `recheckDays must be a whole number of days between 1 and ${MAX_RECHECK_DAYS}` },
          { status: 400 }
        );
      }
      patch.recheckDays = n;
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
    const settings = await saveSettings(patch);
    // The gap is a setting for the whole automation, so a change to it has to
    // reach the domains already being watched, not just the next one to
    // arrive. Elapsed time is kept: see rebaseNextAt.
    const rescheduled =
      patch.recheckDays === undefined
        ? 0
        : await applyRecheckInterval(settings.recheckDays);
    return NextResponse.json({ settings, rescheduled });
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
