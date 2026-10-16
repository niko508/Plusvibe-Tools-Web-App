import { NextResponse } from "next/server";
import { plusvibeGet, resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { BULK_CHUNK, rangeProblem } from "@/lib/inbox-performance/metrics";

export const dynamic = "force-dynamic";

// GET /api/plusvibe/email-stats-bulk
//
// Thin proxy for /account/email-stats/bulk: stats for every sending mailbox
// individually, 100 per call. Forwards the documented filters:
//   workspace_id, start_date, end_date (required; at most 90 days apart),
//   email_acc_ids (comma-separated, at most 100), include_chart, page, limit.
// The client throttles how many of these it fires at once.
export async function GET(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const { searchParams } = new URL(request.url);

    const workspace_id = searchParams.get("workspace_id") ?? "";
    const start_date = searchParams.get("start_date") ?? "";
    const end_date = searchParams.get("end_date") ?? "";
    if (!workspace_id || !start_date || !end_date) {
      return NextResponse.json(
        { error: "workspace_id, start_date and end_date are required" },
        { status: 400 }
      );
    }
    const problem = rangeProblem(start_date, end_date);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });

    const ids = (searchParams.get("email_acc_ids") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length > BULK_CHUNK) {
      return NextResponse.json(
        { error: `At most ${BULK_CHUNK} email_acc_ids per call` },
        { status: 400 }
      );
    }

    const data = await plusvibeGet<unknown>({
      apiKey,
      path: "/account/email-stats/bulk",
      query: {
        workspace_id,
        start_date,
        end_date,
        email_acc_ids: ids.length > 0 ? ids.join(",") : undefined,
        include_chart: searchParams.get("include_chart") === "false" ? "false" : "true",
        page: searchParams.get("page") ?? undefined,
        limit: searchParams.get("limit") ?? undefined,
      },
    });
    return NextResponse.json(data);
  } catch (err) {
    return errorResponse(err);
  }
}
