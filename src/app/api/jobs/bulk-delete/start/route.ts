import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { createJob } from "@/lib/jobs/bulk-delete";
import type { StartJobPayload, DeleteTask } from "@/lib/jobs/types";

export const dynamic = "force-dynamic";

const MAX_TASKS = 100_000;

// POST /api/jobs/bulk-delete/start
// Starts a background job that deletes the given inboxes. Returns { jobId }.
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as Partial<StartJobPayload>;

    const tasks = Array.isArray(body.tasks) ? body.tasks : [];
    if (tasks.length === 0) {
      return NextResponse.json(
        { error: "No inboxes to delete." },
        { status: 400 }
      );
    }
    if (tasks.length > MAX_TASKS) {
      return NextResponse.json(
        { error: `Too many inboxes in one job (max ${MAX_TASKS}).` },
        { status: 400 }
      );
    }
    // Basic shape validation of each task.
    const clean: DeleteTask[] = [];
    for (const t of tasks) {
      if (t && t.workspace_id && t.email && t.domain) {
        clean.push({
          workspace_id: String(t.workspace_id),
          email: String(t.email),
          domain: String(t.domain),
        });
      }
    }
    if (clean.length === 0) {
      return NextResponse.json(
        { error: "No valid inboxes to delete." },
        { status: 400 }
      );
    }

    const payload: StartJobPayload = {
      label: typeof body.label === "string" ? body.label : "",
      workspaceNames:
        body.workspaceNames && typeof body.workspaceNames === "object"
          ? body.workspaceNames
          : {},
      notFound: Array.isArray(body.notFound) ? body.notFound.map(String) : [],
      mode: body.mode === "inbox" ? "inbox" : "domain",
      tasks: clean,
    };

    const jobId = await createJob(apiKey, payload);
    return NextResponse.json({ jobId });
  } catch (err) {
    return errorResponse(err);
  }
}
