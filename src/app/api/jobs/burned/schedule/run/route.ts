import { NextResponse } from "next/server";
import { requireAccountKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { WeeklyBusy, runWeekly, serverApiKey } from "@/lib/jobs/burned-schedule";

export const dynamic = "force-dynamic";

// POST /api/jobs/burned/schedule/run
//   Starts the weekly run now, in the saved mode, with the server's key, and
//   answers straight away; the page follows it through GET …/schedule.
export async function POST(request: Request) {
  try {
    await requireAccountKey(request);
    if (!serverApiKey()) {
      return NextResponse.json(
        { error: "PLUSVIBE_API_KEY is not set on the server, so the weekly run has no key to work with." },
        { status: 501 }
      );
    }
    const started = runWeekly("manual");
    // A run that is already going is refused at once; anything later is the
    // run's own business and is recorded on it.
    const early = await Promise.race([
      started.then(() => null, (err: unknown) => err),
      new Promise((r) => setTimeout(() => r(null), 300)),
    ]);
    if (early instanceof WeeklyBusy) return NextResponse.json({ error: early.message }, { status: 409 });
    if (early instanceof Error) throw early;
    started.catch(() => undefined);
    return NextResponse.json({ started: true });
  } catch (err) {
    return errorResponse(err);
  }
}
