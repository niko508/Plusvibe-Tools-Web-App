import { NextResponse } from "next/server";
import { plusvibeGet, plusvibePost, resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { acquireSlot } from "@/lib/jobs/rate-limit";
import {
  buildWebhookBody,
  hasHookForUrl,
  validateWebhookConfig,
  type ExistingHook,
  type WebhookConfig,
} from "@/lib/webhooks/config";

export const dynamic = "force-dynamic";

// POST /api/bulk-actions/webhooks
// Body: { workspaces: [{ id, name }], config: WebhookConfig, dryRun?: boolean }
//
// Adds one webhook to each selected workspace. Every workspace is attempted
// even if an earlier one fails, and each reports its own outcome — a bulk
// action that stops halfway leaves you guessing which half.

const MAX_WORKSPACES = 200;

interface IncomingWorkspace {
  id?: string;
  name?: string;
}

type Outcome = "added" | "already" | "error";

interface WorkspaceResult {
  workspaceId: string;
  workspaceName: string;
  outcome: Outcome;
  hookId?: string;
  reason?: string;
}

export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as {
      workspaces?: IncomingWorkspace[];
      config?: WebhookConfig;
      dryRun?: boolean;
    };

    const workspaces = (body.workspaces ?? [])
      .map((w) => ({ id: String(w?.id ?? ""), name: String(w?.name ?? "") }))
      .filter((w) => w.id);
    if (workspaces.length === 0) {
      return NextResponse.json(
        { error: "Pick at least one workspace." },
        { status: 400 }
      );
    }
    if (workspaces.length > MAX_WORKSPACES) {
      return NextResponse.json(
        { error: `Too many workspaces (${workspaces.length}); the limit is ${MAX_WORKSPACES}.` },
        { status: 400 }
      );
    }

    const config = body.config;
    if (!config) {
      return NextResponse.json({ error: "Missing webhook config." }, { status: 400 });
    }
    // Validated server-side as well as in the form: a bad URL here would mean
    // one broken webhook per workspace, each needing manual deletion.
    const invalid = validateWebhookConfig(config);
    if (invalid.length > 0) {
      return NextResponse.json({ error: invalid.join(" ") }, { status: 400 });
    }

    const results: WorkspaceResult[] = [];

    for (const ws of workspaces) {
      // Check first: /hook/add has no upsert, so re-running would stack a
      // second webhook on every workspace already reached and double every
      // event it fires.
      let existing: ExistingHook[] = [];
      try {
        await acquireSlot();
        const data = await plusvibeGet<{ hooks?: ExistingHook[] }>({
          apiKey,
          path: "/hook/list",
          query: { workspace_id: ws.id },
        });
        existing = Array.isArray(data?.hooks) ? data.hooks : [];
      } catch (err) {
        results.push({
          workspaceId: ws.id,
          workspaceName: ws.name,
          outcome: "error",
          reason: `Could not list existing webhooks: ${message(err)}. Skipped rather than risk a duplicate.`,
        });
        continue;
      }

      if (hasHookForUrl(existing, config.url)) {
        results.push({
          workspaceId: ws.id,
          workspaceName: ws.name,
          outcome: "already",
        });
        continue;
      }

      if (body.dryRun) {
        results.push({
          workspaceId: ws.id,
          workspaceName: ws.name,
          outcome: "added",
        });
        continue;
      }

      try {
        await acquireSlot();
        const res = await plusvibePost<{ status?: string; _id?: string }>({
          apiKey,
          path: "/hook/add",
          body: buildWebhookBody(config, ws.id),
        });
        results.push({
          workspaceId: ws.id,
          workspaceName: ws.name,
          outcome: "added",
          hookId: typeof res?._id === "string" ? res._id : undefined,
        });
      } catch (err) {
        results.push({
          workspaceId: ws.id,
          workspaceName: ws.name,
          outcome: "error",
          reason: message(err),
        });
      }
    }

    return NextResponse.json({
      dryRun: body.dryRun === true,
      results,
      totals: {
        added: results.filter((r) => r.outcome === "added").length,
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
