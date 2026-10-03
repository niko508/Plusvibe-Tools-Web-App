import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { createJob, planJob } from "@/lib/jobs/pause-campaigns";
import { validateResumeAt } from "@/lib/pause-campaigns/plan";

export const dynamic = "force-dynamic";

const MAX_WORKSPACES = 200;

// POST /api/jobs/pause-campaigns/start
// Body: { workspaces: [{ id, name }], resumeAt?: epoch ms, dryRun?: boolean }
//
// A dry run reads every workspace and reports what would be paused, without
// pausing anything or creating a job.
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as {
      workspaces?: { id?: string; name?: string }[];
      resumeAt?: unknown;
      dryRun?: boolean;
    };

    const workspaces = (body.workspaces ?? [])
      .map((w) => ({ id: String(w?.id ?? ""), name: String(w?.name ?? "") }))
      .filter((w) => w.id);
    if (workspaces.length === 0) {
      return NextResponse.json({ error: "Pick at least one workspace." }, { status: 400 });
    }
    if (workspaces.length > MAX_WORKSPACES) {
      return NextResponse.json(
        { error: `Too many workspaces (${workspaces.length}); the limit is ${MAX_WORKSPACES}.` },
        { status: 400 }
      );
    }

    let resumeAt: number | undefined;
    if (body.resumeAt !== undefined && body.resumeAt !== null) {
      const problem = validateResumeAt(body.resumeAt);
      if (problem) return NextResponse.json({ error: problem }, { status: 400 });
      resumeAt = body.resumeAt as number;
    }

    if (body.dryRun) {
      return NextResponse.json(await planJob(apiKey, { workspaces, resumeAt }));
    }

    const jobId = await createJob(apiKey, { workspaces, resumeAt });
    return NextResponse.json({ jobId });
  } catch (err) {
    return errorResponse(err);
  }
}
