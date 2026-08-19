import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { createJob } from "@/lib/jobs/azure-warmup";
import type { AzureStartPayload, AzureUploadRow } from "@/lib/jobs/azure-warmup-types";
import {
  DEFAULT_SHEET_TAB,
  DEFAULT_SHEET_URL,
  MAX_DELAY_HOURS,
} from "@/lib/jobs/azure-warmup-types";

export const dynamic = "force-dynamic";

const MAX_ROWS = 50_000;

// POST /api/jobs/azure-warmup/start
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as Partial<AzureStartPayload>;

    const workspaceId = body.workspaceId ? String(body.workspaceId) : "";
    if (!workspaceId) {
      return NextResponse.json(
        { error: "workspaceId is required" },
        { status: 400 }
      );
    }

    const delayHours = Number(body.delayHours ?? 0);
    if (!Number.isFinite(delayHours) || delayHours < 0) {
      return NextResponse.json(
        { error: "Delay must be 0 or more hours." },
        { status: 400 }
      );
    }
    if (delayHours > MAX_DELAY_HOURS) {
      return NextResponse.json(
        { error: `Delay can be at most ${MAX_DELAY_HOURS} hours.` },
        { status: 400 }
      );
    }

    const rawRows = Array.isArray(body.rows) ? body.rows : [];
    const seen = new Set<string>();
    const rows: AzureUploadRow[] = [];
    for (const r of rawRows) {
      const email = String(r?.email ?? "").trim().toLowerCase();
      const domain = String(r?.domain ?? "").trim().toLowerCase();
      const orderEmail = String(r?.orderEmail ?? "").trim();
      if (!email || !domain || !orderEmail) continue;
      if (seen.has(email)) continue;
      seen.add(email);
      rows.push({ email, domain, orderEmail });
    }
    if (rows.length === 0) {
      return NextResponse.json(
        { error: "The upload had no usable rows." },
        { status: 400 }
      );
    }
    if (rows.length > MAX_ROWS) {
      return NextResponse.json(
        { error: `Too many rows in one run (max ${MAX_ROWS}).` },
        { status: 400 }
      );
    }

    const payload: AzureStartPayload = {
      workspaceId,
      workspaceName: String(body.workspaceName ?? ""),
      delayHours,
      sheetUrl: String(body.sheetUrl || DEFAULT_SHEET_URL),
      sheetTab: String(body.sheetTab || DEFAULT_SHEET_TAB),
      rows,
    };
    const jobId = await createJob(apiKey, payload);
    return NextResponse.json({ jobId });
  } catch (err) {
    return errorResponse(err);
  }
}
