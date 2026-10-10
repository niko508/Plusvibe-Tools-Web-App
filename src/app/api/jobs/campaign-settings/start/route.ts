import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { ActiveJobError, createJob } from "@/lib/jobs/campaign-settings";
import type { SettingChange } from "@/lib/campaign-settings/settings";

export const dynamic = "force-dynamic";

const MAX_WORKSPACES = 200;

// POST /api/jobs/campaign-settings/start
// Body: { workspaces: [{ id, name }], changes: [{ key, value }], includeSubsequences? }
// Starts the job; it runs in the background and is polled via /list.
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as {
      workspaces?: { id?: string; name?: string }[];
      changes?: { key?: unknown; value?: unknown }[];
      includeSubsequences?: boolean;
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
    const changes: SettingChange[] = (Array.isArray(body.changes) ? body.changes : []).map((c) => ({
      key: String(c?.key ?? ""),
      value: typeof c?.value === "number" ? c.value : String(c?.value ?? ""),
    }));
    if (changes.length === 0) {
      return NextResponse.json({ error: "Pick at least one setting to change." }, { status: 400 });
    }
    const jobId = await createJob(apiKey, { workspaces, changes, includeSubsequences: body.includeSubsequences === true });
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
