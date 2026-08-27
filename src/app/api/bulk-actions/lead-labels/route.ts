import { NextResponse } from "next/server";
import { plusvibeGet, resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { acquireSlot } from "@/lib/jobs/rate-limit";
import { labelEventType, type LeadLabel } from "@/lib/webhooks/config";

export const dynamic = "force-dynamic";

const MAX_WORKSPACES = 50;

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
