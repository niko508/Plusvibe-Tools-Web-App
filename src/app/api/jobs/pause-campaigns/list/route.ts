import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { listJobs, serverApiKey } from "@/lib/jobs/pause-campaigns";
import type { PauseCampaignsView } from "@/lib/jobs/pause-campaigns-types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const view: PauseCampaignsView = {
      jobs: await listJobs(apiKey),
      readiness: { serverKey: serverApiKey() !== null },
    };
    return NextResponse.json(view);
  } catch (err) {
    return errorResponse(err);
  }
}
