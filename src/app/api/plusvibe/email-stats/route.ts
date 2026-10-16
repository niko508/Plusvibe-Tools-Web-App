import { NextResponse } from "next/server";
import { plusvibeGet, resolveApiKey } from "@/lib/plusvibe-server";
import type { EmailStatsResponse } from "@/lib/plusvibe-types";
import { errorResponse } from "@/lib/api-response";

export const dynamic = "force-dynamic";

// GET /api/plusvibe/email-stats
// Thin proxy for /account/email-stats. Forwards the documented filters:
//   workspace_id (required), start_date, end_date, email_acc_id,
//   provider, tags, recp_provider, domain.
// The client throttles how many of these it fires concurrently to respect the
// Plusvibe 5 req/s limit.
export async function GET(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const { searchParams } = new URL(request.url);

    const workspace_id = searchParams.get("workspace_id") ?? undefined;
    const start_date = searchParams.get("start_date") ?? undefined;
    const end_date = searchParams.get("end_date") ?? undefined;

    if (!workspace_id || !start_date || !end_date) {
      return NextResponse.json(
        { error: "workspace_id, start_date and end_date are required" },
        { status: 400 }
      );
    }

    const data = await plusvibeGet<EmailStatsResponse>({
      apiKey,
      path: "/account/email-stats",
      query: {
        workspace_id,
        start_date,
        end_date,
        email_acc_id: searchParams.get("email_acc_id") ?? undefined,
        provider: searchParams.get("provider") ?? undefined,
        tags: searchParams.get("tags") ?? undefined,
        recp_provider: searchParams.get("recp_provider") ?? undefined,
        domain: searchParams.get("domain") ?? undefined,
      },
    });

    return NextResponse.json(data);
  } catch (err) {
    return errorResponse(err);
  }
}
