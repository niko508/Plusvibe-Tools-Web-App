import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { ActiveJobError, createJob } from "@/lib/jobs/inbox-tags";
import type { RuleInput, Scope } from "@/lib/inbox-tags/plan";

export const dynamic = "force-dynamic";

const MAX_WORKSPACES = 200;
const MAX_RULES = 20;

// POST /api/jobs/inbox-tags/start
// Body: { workspaces: [{ id, name }], rules: [{ scope, tagName, color }] }
// Starts the job; it runs in the background and is polled via /list.
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as {
      workspaces?: { id?: string; name?: string }[];
      rules?: { scope?: string; tagName?: string; color?: string }[];
    };
    const workspaces = (body.workspaces ?? [])
      .map((w) => ({ id: String(w?.id ?? ""), name: String(w?.name ?? "") }))
      .filter((w) => w.id);
    if (workspaces.length === 0) {
      return NextResponse.json({ error: "Pick at least one workspace." }, { status: 400 });
    }
    if (workspaces.length > MAX_WORKSPACES) {
      return NextResponse.json({ error: `Too many workspaces (${workspaces.length}); the limit is ${MAX_WORKSPACES}.` }, { status: 400 });
    }
    const rules: RuleInput[] = (Array.isArray(body.rules) ? body.rules : []).map((r) => ({
      scope: String(r?.scope ?? "") as Scope,
      tagName: String(r?.tagName ?? ""),
      color: String(r?.color ?? ""),
    }));
    if (rules.length === 0) {
      return NextResponse.json({ error: "Add at least one rule." }, { status: 400 });
    }
    if (rules.length > MAX_RULES) {
      return NextResponse.json({ error: `Too many rules (${rules.length}); the limit is ${MAX_RULES}.` }, { status: 400 });
    }
    const jobId = await createJob(apiKey, { workspaces, rules });
    return NextResponse.json({ jobId });
  } catch (err) {
    if (err instanceof ActiveJobError) {
      return NextResponse.json({ error: err.message, activeJobId: err.activeJobId }, { status: 409 });
    }
    if (err instanceof Error && !("status" in err)) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return errorResponse(err);
  }
}
