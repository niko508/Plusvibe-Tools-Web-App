import { NextResponse } from "next/server";
import { plusvibeGet, plusvibePost, resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { acquireSlot } from "@/lib/jobs/rate-limit";
import { labelEventType, type LeadLabel } from "@/lib/webhooks/config";
import type { WorkspaceLabel } from "@/lib/lead-labels/normalize";
import {
  classifyWorkspace,
  isSentiment,
  validateLabelName,
  type LabelOutcome,
  type MatchKind,
  type Sentiment,
} from "@/lib/lead-labels/custom-label";

export const dynamic = "force-dynamic";

const MAX_WORKSPACES = 50;
/** Creating is one write per workspace, so it tolerates a wider fan-out. */
const MAX_CREATE_WORKSPACES = 200;

interface RawLabel {
  id?: string | null;
  key?: string;
  name?: string;
  sentiment?: string;
  icon?: string;
  is_system?: number;
  is_ai_label?: number;
}

/** A label, plus which of the requested workspaces actually have it. */
interface MergedLabel extends LeadLabel {
  eventType: string;
  /** How many of the requested workspaces expose this label. */
  presentIn: number;
}

// GET /api/bulk-actions/lead-labels?workspace_ids=a,b,c
//
// Labels are per-workspace, so a bulk webhook targeting a label has to know
// which workspaces actually have it — subscribing to a label a workspace
// doesn't define would either fail or create a webhook that never fires.
// The union is returned with a per-label count so the UI can say so.
export async function GET(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const ids = (new URL(request.url).searchParams.get("workspace_ids") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (ids.length === 0) {
      return NextResponse.json(
        { error: "workspace_ids is required" },
        { status: 400 }
      );
    }
    if (ids.length > MAX_WORKSPACES) {
      return NextResponse.json(
        {
          error: `Labels can be read for up to ${MAX_WORKSPACES} workspaces at a time (asked for ${ids.length}).`,
        },
        { status: 400 }
      );
    }

    const byKey = new Map<string, MergedLabel>();
    const failed: string[] = [];

    for (const workspace_id of ids) {
      try {
        await acquireSlot();
        const data = await plusvibeGet<unknown>({
          apiKey,
          path: "/workspace-settings/lead-labels",
          query: { workspace_id },
        });
        for (const raw of asLabelArray(data)) {
          const key = String(raw.key ?? "").trim();
          if (!key) continue;
          const existing = byKey.get(key);
          if (existing) {
            existing.presentIn += 1;
            continue;
          }
          byKey.set(key, {
            key,
            name: String(raw.name ?? key),
            sentiment: String(raw.sentiment ?? ""),
            isSystem: raw.is_system === 1,
            eventType: labelEventType(key),
            presentIn: 1,
          });
        }
      } catch {
        // One unreadable workspace shouldn't hide every other workspace's
        // labels; it's reported instead so the counts can be read correctly.
        failed.push(workspace_id);
      }
    }

    const labels = Array.from(byKey.values()).sort((a, b) => {
      // Labels present everywhere first — those are the safe ones to pick.
      if (a.presentIn !== b.presentIn) return b.presentIn - a.presentIn;
      return a.name.localeCompare(b.name);
    });

    return NextResponse.json({
      labels,
      workspacesRead: ids.length - failed.length,
      workspacesRequested: ids.length,
      failed,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

// POST /api/bulk-actions/lead-labels
// Body: { workspaces: [{ id, name }], name, sentiment?, dryRun? }
//
// Creates the same custom lead label in each selected workspace. Every
// workspace is attempted even if an earlier one fails, and each reports its own
// outcome — a bulk action that stops halfway leaves you guessing which half.
//
// There is no edit endpoint for lead labels, so a name created in fifty
// workspaces has to be deleted from fifty workspaces by hand. That is why the
// name is validated here as well as in the form, and why the preview exists.

interface CreateResult {
  workspaceId: string;
  workspaceName: string;
  outcome: LabelOutcome;
  /** The label already present, when one was found. */
  existingName?: string;
  matchedBy?: MatchKind;
  key?: string;
  reason?: string;
}

export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as {
      workspaces?: IncomingWorkspace[];
      name?: string;
      sentiment?: string;
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
    if (workspaces.length > MAX_CREATE_WORKSPACES) {
      return NextResponse.json(
        {
          error: `Too many workspaces (${workspaces.length}); the limit is ${MAX_CREATE_WORKSPACES}.`,
        },
        { status: 400 }
      );
    }

    const name = String(body.name ?? "").trim();
    const problems = validateLabelName(name);
    if (problems.length > 0) {
      return NextResponse.json({ error: problems.join(" ") }, { status: 400 });
    }

    const sentiment: Sentiment = isSentiment(body.sentiment)
      ? body.sentiment
      : "POSITIVE";
    const dryRun = body.dryRun === true;
    const results: CreateResult[] = [];

    for (const ws of workspaces) {
      // Read first: the label list is what tells "already has it" apart from
      // "safe to create", and creating blind would fail on every workspace
      // already set up by hand.
      let existing: WorkspaceLabel[];
      try {
        await acquireSlot();
        const data = await plusvibeGet<unknown>({
          apiKey,
          path: "/workspace-settings/lead-labels",
          query: { workspace_id: ws.id },
        });
        existing = asLabelArray(data).map((l) => ({
          key: String(l.key ?? ""),
          name: String(l.name ?? ""),
          isSystem: l.is_system === 1,
        }));
      } catch (err) {
        results.push({
          workspaceId: ws.id,
          workspaceName: ws.name,
          outcome: "error",
          reason: `Could not read the existing labels: ${message(err)}. Skipped rather than risk a duplicate.`,
        });
        continue;
      }

      const decision = classifyWorkspace(name, existing);
      if (decision.action === "already") {
        results.push({
          workspaceId: ws.id,
          workspaceName: ws.name,
          outcome: "already",
          existingName: decision.existing?.name,
          matchedBy: decision.matchedBy,
          key: decision.existing?.key,
        });
        continue;
      }
      if (decision.action === "conflict") {
        results.push({
          workspaceId: ws.id,
          workspaceName: ws.name,
          outcome: "conflict",
          existingName: decision.existing?.name,
          matchedBy: decision.matchedBy,
        });
        continue;
      }

      if (dryRun) {
        results.push({
          workspaceId: ws.id,
          workspaceName: ws.name,
          outcome: "created",
        });
        continue;
      }

      try {
        await acquireSlot();
        const res = await plusvibePost<Record<string, unknown>>({
          apiKey,
          path: "/workspace-settings/lead-labels/add",
          body: { workspace_id: ws.id, name, sentiment },
        });
        results.push({
          workspaceId: ws.id,
          workspaceName: ws.name,
          outcome: "created",
          key: typeof res?.key === "string" ? res.key : undefined,
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
      dryRun,
      name,
      sentiment,
      results,
      totals: {
        created: results.filter((r) => r.outcome === "created").length,
        already: results.filter((r) => r.outcome === "already").length,
        conflict: results.filter((r) => r.outcome === "conflict").length,
        errors: results.filter((r) => r.outcome === "error").length,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

interface IncomingWorkspace {
  id?: string;
  name?: string;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

function asLabelArray(data: unknown): RawLabel[] {
  if (Array.isArray(data)) return data as RawLabel[];
  if (data && typeof data === "object") {
    for (const k of ["labels", "lead_labels", "data", "result"]) {
      const v = (data as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as RawLabel[];
    }
  }
  return [];
}
