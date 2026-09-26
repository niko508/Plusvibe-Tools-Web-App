import { NextResponse } from "next/server";
import { requireAccountKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { listJobs, rejudgeAllStatus, serverApiKey } from "@/lib/jobs/blocked-domains";
import { listInboxDomains, listInboxJobs } from "@/lib/jobs/blocked-inboxes";
import { loadSettings } from "@/lib/blocked-domains/settings";
import { envSpreadsheetId, isSheetWritingConfigured } from "@/lib/google-sheets";
import { jobStorageInfo } from "@/lib/jobs/storage";
import type { BlockedDomainsView } from "@/lib/jobs/blocked-domains-types";

export const dynamic = "force-dynamic";

// GET /api/jobs/blocked-domains/list
//
// The log is shared rather than scoped per API key — it's written by a webhook
// with no user attached — so a valid key is what gates reading it.
export async function GET(request: Request) {
  try {
    await requireAccountKey(request);
    const [jobs, inboxJobs, inboxDomains, settings] = await Promise.all([listJobs(), listInboxJobs(), listInboxDomains(), loadSettings()]);
    const view: BlockedDomainsView = {
      jobs,
      inboxJobs,
      inboxDomains,
      rejudgeAll: rejudgeAllStatus(),
      settings: {
        autoDelete: settings.autoDelete,
        checkPerformance: settings.checkPerformance,
        minReplyRateOoo: settings.minReplyRateOoo,
        minDomainReplyRateOoo: settings.minDomainReplyRateOoo,
        recheck: settings.recheck,
        recheckDays: settings.recheckDays,
        inboxRules: settings.inboxRules,
        cancelAfterDeleted: settings.cancelAfterDeleted,
        cancelKeepReplyRate: settings.cancelKeepReplyRate,
      },
      readiness: {
        serverKey: serverApiKey() !== null,
        spreadsheet: envSpreadsheetId() !== null,
        sheetWriting: isSheetWritingConfigured(),
        webhookSecret:
          (process.env.BLOCKED_DOMAIN_WEBHOOK_SECRET?.trim() ?? "") !== "",
        jobStorage: jobStorageInfo(),
      },
    };
    return NextResponse.json(view);
  } catch (err) {
    return errorResponse(err);
  }
}
