import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { ActiveJobError, createJob } from "@/lib/jobs/change-limits";
import {
  EMPTY_SETTINGS,
  type SettingsBundle,
  type SettingsInput,
} from "@/lib/change-limits/settings";
import type { ProviderBucket } from "@/lib/plusvibe-providers";
import type { ChangeLimitsTarget } from "@/lib/jobs/change-limits-types";

export const dynamic = "force-dynamic";

const MAX_WORKSPACES = 200;
const MAX_INBOXES = 50_000;

// POST /api/jobs/change-limits/start
// Body: { settings, targets: [{ workspaceId, workspaceName, inboxes: [{id,email}] }] }
// Starts the job; it runs in the background and is polled via /list.
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as {
      settings?: Partial<SettingsBundle>;
      targets?: {
        workspaceId?: string;
        workspaceName?: string;
        provider?: string;
        inboxes?: { id?: string; email?: string }[];
      }[];
    };

    const readInput = (raw: unknown): SettingsInput => {
      const out: SettingsInput = { ...EMPTY_SETTINGS };
      if (!raw || typeof raw !== "object") return out;
      const src = raw as Record<string, unknown>;
      for (const key of Object.keys(EMPTY_SETTINGS) as (keyof SettingsInput)[]) {
        const v = src[key];
        if (typeof v === "string" || typeof v === "number") out[key] = String(v);
      }
      return out;
    };
    const settings: SettingsBundle = {
      sameForAll: body.settings?.sameForAll !== false,
      all: readInput(body.settings?.all),
      google: readInput(body.settings?.google),
      microsoft: readInput(body.settings?.microsoft),
      other: readInput(body.settings?.other),
    };

    const asProvider = (v: unknown): ProviderBucket =>
      v === "google" || v === "microsoft" ? v : "other";

    const targets: ChangeLimitsTarget[] = [];
    let inboxCount = 0;
    for (const t of body.targets ?? []) {
      const workspaceId = String(t?.workspaceId ?? "");
      if (!workspaceId) continue;
      const inboxes = (t.inboxes ?? [])
        .map((b) => ({ id: String(b?.id ?? ""), email: String(b?.email ?? "") }))
        .filter((b) => b.id);
      if (inboxes.length === 0) continue;
      inboxCount += inboxes.length;
      targets.push({
        workspaceId,
        workspaceName: String(t.workspaceName ?? workspaceId),
        provider: asProvider(t.provider),
        inboxes,
      });
    }

    if (targets.length === 0) {
      return NextResponse.json({ error: "No inboxes to update." }, { status: 400 });
    }
    if (targets.length > MAX_WORKSPACES) {
      return NextResponse.json(
        { error: `Too many workspaces (${targets.length}); the limit is ${MAX_WORKSPACES}.` },
        { status: 400 }
      );
    }
    if (inboxCount > MAX_INBOXES) {
      return NextResponse.json(
        { error: `Too many inboxes in one run (${inboxCount}); the limit is ${MAX_INBOXES}.` },
        { status: 400 }
      );
    }

    const jobId = await createJob(apiKey, { settings, targets });
    return NextResponse.json({ jobId });
  } catch (err) {
    if (err instanceof ActiveJobError) {
      return NextResponse.json(
        { error: err.message, activeJobId: err.activeJobId },
        { status: 409 }
      );
    }
    if (err instanceof Error && !("status" in err)) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return errorResponse(err);
  }
}
