import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { ActiveJobError, createJob } from "@/lib/jobs/domain-tags";
import type { TagInput } from "@/lib/tags/bulk-tags";

export const dynamic = "force-dynamic";

const MAX_WORKSPACES = 200;
const MAX_TAGS = 50;

function tags(raw: unknown): TagInput[] {
  return (Array.isArray(raw) ? raw : [])
    .slice(0, MAX_TAGS)
    .map((t) => ({ name: String((t as { name?: unknown })?.name ?? ""), color: String((t as { color?: unknown })?.color ?? "") }));
}

// POST /api/jobs/domain-tags/start
// Body: { workspaces: [{ id, name }], tldTags: [{ name, color }], platformTags: [{ name, color }], sheetUrl?, sheetTab? }
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as {
      workspaces?: { id?: string; name?: string }[];
      tldTags?: unknown;
      platformTags?: unknown;
      sheetUrl?: string;
      sheetTab?: string;
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
    const jobId = await createJob(apiKey, {
      workspaces,
      tldTags: tags(body.tldTags),
      platformTags: tags(body.platformTags),
      sheetUrl: typeof body.sheetUrl === "string" ? body.sheetUrl : undefined,
      sheetTab: typeof body.sheetTab === "string" ? body.sheetTab : undefined,
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
