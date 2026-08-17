import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { createJob } from "@/lib/jobs/remove-50";
import type {
  Remove50DomainPlan,
  Remove50StartPayload,
  WarmupSettings,
} from "@/lib/jobs/remove-50-types";

export const dynamic = "force-dynamic";

const MAX_DOMAINS = 5_000;

// POST /api/jobs/remove-50/start
// Starts a background job that trims each domain down to the target and applies
// the warmup settings. Returns { jobId }.
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as Partial<Remove50StartPayload>;

    const workspaceId = body.workspaceId ? String(body.workspaceId) : "";
    if (!workspaceId) {
      return NextResponse.json(
        { error: "workspaceId is required" },
        { status: 400 }
      );
    }

    const rawDomains = Array.isArray(body.domains) ? body.domains : [];
    const domains: Remove50DomainPlan[] = [];
    for (const d of rawDomains) {
      if (!d || !d.domain) continue;
      const deleteEmails = Array.isArray(d.deleteEmails)
        ? d.deleteEmails.map(String).filter(Boolean)
        : [];
      const keepIds = Array.isArray(d.keepIds)
        ? d.keepIds.map(String).filter(Boolean)
        : [];
      if (deleteEmails.length === 0) continue; // only trimmed domains
      domains.push({
        domain: String(d.domain),
        total: typeof d.total === "number" ? d.total : deleteEmails.length + keepIds.length,
        deleteEmails,
        keepIds,
      });
    }

    if (domains.length === 0) {
      return NextResponse.json(
        { error: "No domains to trim." },
        { status: 400 }
      );
    }
    if (domains.length > MAX_DOMAINS) {
      return NextResponse.json(
        { error: `Too many domains in one job (max ${MAX_DOMAINS}).` },
        { status: 400 }
      );
    }

    const settings: WarmupSettings =
      body.settings && typeof body.settings === "object" ? body.settings : {};

    const payload: Remove50StartPayload = {
      label: typeof body.label === "string" ? body.label : "",
      workspaceId,
      workspaceName:
        typeof body.workspaceName === "string" ? body.workspaceName : "",
      target: typeof body.target === "number" ? body.target : 50,
      settings,
      domains,
    };

    const jobId = await createJob(apiKey, payload);
    return NextResponse.json({ jobId });
  } catch (err) {
    return errorResponse(err);
  }
}
