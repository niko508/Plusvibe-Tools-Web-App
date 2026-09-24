import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import {
  confirmAllInboxes,
  confirmInbox,
  dismissInbox,
  intakeInbox,
  intakeTenantBlock,
  removeInboxJob,
} from "@/lib/jobs/blocked-inboxes";

export const dynamic = "force-dynamic";

// POST /api/jobs/blocked-inboxes/action
// Body: { action: "confirm" | "dismiss" | "remove", jobId }
//     | { action: "confirm-all" }
//     | { action: "check", email }   — run one inbox by hand, as Clay would
//     | { action: "tenant-block", domain } — block a whole domain by hand
//
// Like the list, the log is shared rather than per key, so a valid key is
// what gates it; the work itself runs with the server's own key.
export async function POST(request: Request) {
  try {
    resolveApiKey(request);
    const body = (await request.json().catch(() => ({}))) as { action?: string; jobId?: string; email?: string; domain?: string };
    switch (body.action) {
      case "confirm":
      case "dismiss":
      case "remove": {
        if (!body.jobId) return NextResponse.json({ error: "jobId is required" }, { status: 400 });
        const fn = body.action === "confirm" ? confirmInbox : body.action === "dismiss" ? dismissInbox : removeInboxJob;
        const ok = await fn(body.jobId);
        if (!ok) return NextResponse.json({ error: "That inbox can't do that right now." }, { status: 409 });
        return NextResponse.json({ ok });
      }
      case "confirm-all":
        return NextResponse.json({ ok: true, deleting: await confirmAllInboxes() });
      case "check": {
        const r = await intakeInbox({ email: body.email, source: "manual" });
        if (r.outcome === "invalid") return NextResponse.json({ error: r.reason }, { status: 400 });
        return NextResponse.json({ ok: true, outcome: r.outcome, jobId: r.job.id });
      }
      case "tenant-block": {
        const r = await intakeTenantBlock({ domain: body.domain, email: body.email, source: "manual" });
        if (r.outcome === "invalid") return NextResponse.json({ error: r.reason }, { status: 400 });
        return NextResponse.json({ ok: true, outcome: r.outcome, domain: r.domain });
      }
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (err) {
    return errorResponse(err);
  }
}
