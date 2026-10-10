import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { ActiveJobError, createJob } from "@/lib/jobs/copy-replace";
import { sanitizeEdit } from "@/lib/copy-sections/apply-campaign";

export const dynamic = "force-dynamic";

const MAX_WORKSPACES = 200;

// POST /api/jobs/copy-replace/start
// Body: { workspaces: [{ id, name }], edit: { kind: "replace-text", … }, includeSubsequences? }
// Starts the scan. Nothing is written until the job is confirmed.
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as {
      workspaces?: { id?: string; name?: string; campaignIds?: unknown }[];
      edit?: unknown;
      includeSubsequences?: boolean;
    };
    const workspaces = (body.workspaces ?? [])
      .map((w) => ({
        id: String(w?.id ?? ""),
        name: String(w?.name ?? ""),
        campaignIds: Array.isArray(w?.campaignIds)
          ? w.campaignIds.map(String).filter(Boolean).slice(0, 1000)
          : undefined,
      }))
      .filter((w) => w.id);
    if (workspaces.length === 0) {
      return NextResponse.json({ error: "Pick at least one workspace." }, { status: 400 });
    }
    if (workspaces.length > MAX_WORKSPACES) {
      return NextResponse.json({ error: `Too many workspaces (${workspaces.length}); the limit is ${MAX_WORKSPACES}.` }, { status: 400 });
    }
    const edit = sanitizeEdit(body.edit);
    if (!edit || edit.kind !== "replace-text") {
      return NextResponse.json({ error: "Only find & replace can run in bulk." }, { status: 400 });
    }
    const jobId = await createJob(apiKey, {
      workspaces,
      edit,
      includeSubsequences: body.includeSubsequences === true,
    });
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
