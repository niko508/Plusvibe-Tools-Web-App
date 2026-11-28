import { NextResponse } from "next/server";
import { requireAccountKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { TldSettingsProblem, saveTldSettings } from "@/lib/jobs/tld-performance";

export const dynamic = "force-dynamic";

// PUT /api/jobs/tld-performance/settings
//   Body: any of { enabled, sheetUrl, sheetTab, rules: { minDomains, minClients, hiddenPlatforms } }
//   Whatever is left out keeps what it had.
export async function PUT(request: Request) {
  try {
    await requireAccountKey(request);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return NextResponse.json({ error: "Send the settings to save." }, { status: 400 });
    return NextResponse.json({ settings: await saveTldSettings(body) });
  } catch (err) {
    if (err instanceof TldSettingsProblem) {
      return NextResponse.json({ error: err.problems.join(" "), problems: err.problems }, { status: 400 });
    }
    return errorResponse(err);
  }
}
