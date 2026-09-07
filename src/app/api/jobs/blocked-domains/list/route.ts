import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { listJobs, serverApiKey } from "@/lib/jobs/blocked-domains";
import { loadSettings } from "@/lib/blocked-domains/settings";
import { envSpreadsheetId, isSheetWritingConfigured } from "@/lib/google-sheets";
import type { BlockedDomainsView } from "@/lib/jobs/blocked-domains-types";

export const dynamic = "force-dynamic";

// GET /api/jobs/blocked-domains/list
//
// The log is shared rather than scoped per API key — it's written by a webhook
// with no user attached — so a valid key is what gates reading it.
export async function GET(request: Request) {
  try {
    resolveApiKey(request);
    const [jobs, settings] = await Promise.all([listJobs(), loadSettings()]);
    const view: BlockedDomainsView = {
      jobs,
      settings: {
        autoDelete: settings.autoDelete,
        checkPerformance: settings.checkPerformance,
        minReplyRateOoo: settings.minReplyRateOoo,
      },
      readiness: {
        serverKey: serverApiKey() !== null,
        spreadsheet: envSpreadsheetId() !== null,
        sheetWriting: isSheetWritingConfigured(),
        webhookSecret:
          (process.env.BLOCKED_DOMAIN_WEBHOOK_SECRET?.trim() ?? "") !== "",
      },
    };
    return NextResponse.json(view);
  } catch (err) {
    return errorResponse(err);
  }
}
