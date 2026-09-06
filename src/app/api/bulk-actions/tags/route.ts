import { NextResponse } from "next/server";
import { plusvibePost, resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { acquireSlot } from "@/lib/jobs/rate-limit";
import { listTags } from "@/lib/plusvibe-tags";
import {
  classifyApiError,
  findExisting,
  prepareBatch,
  type TagInput,
  type TagOutcome,
} from "@/lib/tags/bulk-tags";

export const dynamic = "force-dynamic";

const MAX_WORKSPACES = 200;
const MAX_TAGS = 50;

// POST /api/bulk-actions/tags
// Body: { workspaces: [{ id, name }], tags: [{ name, color, description? }], dryRun? }
//
// Creates every tag in every selected workspace. Each workspace's tags are
// read once, then each tag is created or skipped. Every workspace is attempted
// even if an earlier one fails, and every (workspace, tag) pair reports its own
// outcome.

export interface TagResult {
  workspaceId: string;
  workspaceName: string;
  tag: string;
  outcome: TagOutcome;
  existingName?: string;
  tagId?: string;
  reason?: string;
}

export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as {
      workspaces?: { id?: string; name?: string }[];
      tags?: TagInput[];
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

    const inputs = (Array.isArray(body.tags) ? body.tags : []).map((t) => ({
      name: String(t?.name ?? ""),
      color: String(t?.color ?? ""),
      description: t?.description === undefined ? undefined : String(t.description),
    }));
    if (inputs.length === 0) {
      return NextResponse.json({ error: "Add at least one tag." }, { status: 400 });
    }
    if (inputs.length > MAX_TAGS) {
      return NextResponse.json({ error: `Too many tags in one go (${inputs.length}); the limit is ${MAX_TAGS}.` }, { status: 400 });
    }
    // Validated server-side as well as in the form: a bad row here would mean
    // one refused create per workspace.
    const batch = prepareBatch(inputs);
    if (batch.problems.size > 0) {
      const first = [...batch.problems.entries()][0];
      return NextResponse.json(
        { error: `Tag ${first[0] + 1}: ${first[1].join(" ")}` },
        { status: 400 }
      );
    }
    const dryRun = body.dryRun === true;
    const results: TagResult[] = [];

    for (const ws of workspaces) {
      let existing;
      try {
        await acquireSlot();
        existing = await listTags(apiKey, ws.id);
      } catch (err) {
        for (const spec of batch.specs) {
          results.push({
            workspaceId: ws.id,
            workspaceName: ws.name,
            tag: spec.name,
            outcome: "error",
            reason: `Could not read the existing tags: ${message(err)}. Skipped rather than risk a duplicate.`,
          });
        }
        continue;
      }

      for (const spec of batch.specs) {
        const have = findExisting(spec.name, existing);
        if (have) {
          results.push({
            workspaceId: ws.id,
            workspaceName: ws.name,
            tag: spec.name,
            outcome: "already",
            existingName: have.name,
            tagId: have.id,
          });
          continue;
        }
        if (dryRun) {
          results.push({ workspaceId: ws.id, workspaceName: ws.name, tag: spec.name, outcome: "created" });
          continue;
        }
        try {
          await acquireSlot();
          const res = await plusvibePost<{ status?: string; tag_id?: string }>({
            apiKey,
            path: "/tags/create",
            body: { workspace_id: ws.id, ...spec },
          });
          results.push({
            workspaceId: ws.id,
            workspaceName: ws.name,
            tag: spec.name,
            outcome: "created",
            tagId: typeof res?.tag_id === "string" ? res.tag_id : undefined,
          });
        } catch (err) {
          const reason = message(err);
          results.push({
            workspaceId: ws.id,
            workspaceName: ws.name,
            tag: spec.name,
            outcome: classifyApiError(reason),
            reason,
          });
        }
      }
    }

    return NextResponse.json({
      dryRun,
      tags: batch.specs,
      duplicatesDropped: batch.duplicates.length,
      results,
      totals: {
        created: results.filter((r) => r.outcome === "created").length,
        already: results.filter((r) => r.outcome === "already").length,
        errors: results.filter((r) => r.outcome === "error").length,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}
