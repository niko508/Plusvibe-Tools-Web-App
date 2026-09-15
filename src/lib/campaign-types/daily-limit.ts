import "server-only";

import { plusvibePatch } from "@/lib/plusvibe-server";
import { acquireSlot } from "@/lib/jobs/rate-limit";

// The campaign-level "Maximum emails per day".
//
//   PATCH /campaign/update/campaign  { workspace_id, campaign_id, daily_limit }
//
// Only this field is sent. The same endpoint replaces `sequences` wholesale
// when they are in the body, so a limit write must never carry them — that
// is why this lives apart from the copy edits rather than riding along.

export async function setCampaignDailyLimit(params: {
  apiKey: string;
  workspaceId: string;
  campaignId: string;
  dailyLimit: number;
}): Promise<void> {
  await acquireSlot();
  await plusvibePatch<{ status?: string }>({
    apiKey: params.apiKey,
    path: "/campaign/update/campaign",
    body: {
      workspace_id: params.workspaceId,
      campaign_id: params.campaignId,
      daily_limit: params.dailyLimit,
    },
  });
}
