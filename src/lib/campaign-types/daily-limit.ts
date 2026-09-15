import "server-only";

import { plusvibePatch } from "@/lib/plusvibe-server";
import { acquireSlot } from "@/lib/jobs/rate-limit";
import { fetchCampaignRaw } from "@/lib/plusvibe-campaigns";
import { readDailyLimits, readSchedules, withDailyLimit } from "./schedule-limit";

// The campaign-level "Maximum emails per day".
//
//   GET   /campaign/list-all?campaign_id=…        the schedules it has now
//   PATCH /campaign/update/campaign               { workspace_id, campaign_id, schedules }
//   GET   /campaign/list-all?campaign_id=…        read back to confirm
//
// The limit is a field of the schedule, and `schedules` is replaced wholesale
// on write, so the current ones are read first and sent back with only that
// field changed. Only `schedules` is sent: the same endpoint replaces
// `sequences` when they are in the body, so a limit write must never carry
// them — that is why this lives apart from the copy edits.

export async function setCampaignDailyLimit(params: {
  apiKey: string;
  workspaceId: string;
  campaignId: string;
  dailyLimit: number;
}): Promise<void> {
  const { apiKey, workspaceId, campaignId, dailyLimit } = params;

  await acquireSlot();
  const before = (await fetchCampaignRaw(apiKey, workspaceId, campaignId)) as Record<string, unknown> | null;
  const schedules = readSchedules(before);
  if (schedules.length === 0) {
    throw new Error("the campaign reports no schedule to set it on");
  }

  await acquireSlot();
  await plusvibePatch<{ status?: string }>({
    apiKey,
    path: "/campaign/update/campaign",
    body: {
      workspace_id: workspaceId,
      campaign_id: campaignId,
      schedules: withDailyLimit(schedules, dailyLimit),
    },
  });

  // The PATCH response does not echo the schedule, so read it back.
  await acquireSlot();
  const after = (await fetchCampaignRaw(apiKey, workspaceId, campaignId)) as Record<string, unknown> | null;
  const got = readDailyLimits(after);
  if (got.length === 0 || got.some((v) => v !== dailyLimit)) {
    throw new Error(`written, but it read back as ${got.length ? got.join(" / ") : "no schedule"}`);
  }
}
