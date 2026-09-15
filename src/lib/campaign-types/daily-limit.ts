import "server-only";

import { plusvibePatch, PlusvibeError } from "@/lib/plusvibe-server";
import { acquireSlot } from "@/lib/jobs/rate-limit";
import { fetchCampaignRaw } from "@/lib/plusvibe-campaigns";
import { readDailyLimit, readSchedule, scheduleForWrite, todayIn } from "./schedule-limit";

// The campaign-level "Maximum emails per day".
//
//   GET   /campaign/list-all?campaign_id=…   the schedule as it is now
//   PATCH /campaign/update/campaign          { workspace_id, campaign_id, schedules: [ … ] }
//   GET   /campaign/list-all?campaign_id=…   read back to confirm
//
// The limit is a field of the schedule on the write side and of the campaign
// on the read side, and the two sides spell the schedule differently — the
// translation is in schedule-limit.ts. Only `schedules` is sent: the same
// endpoint replaces `sequences` when they are in the body, so a limit write
// must never carry them.

export async function setCampaignDailyLimit(params: {
  apiKey: string;
  workspaceId: string;
  campaignId: string;
  dailyLimit: number;
}): Promise<void> {
  const { apiKey, workspaceId, campaignId, dailyLimit } = params;

  await acquireSlot();
  const before = (await fetchCampaignRaw(apiKey, workspaceId, campaignId)) as Record<string, unknown> | null;
  const schedule = readSchedule(before);
  if (!schedule) {
    throw new Error("the campaign reports no schedule (days, timezone and send window) to set it on");
  }

  const write = async (startDate: string) => {
    await acquireSlot();
    await plusvibePatch<{ status?: string }>({
      apiKey,
      path: "/campaign/update/campaign",
      body: {
        workspace_id: workspaceId,
        campaign_id: campaignId,
        schedules: [scheduleForWrite(schedule, dailyLimit, startDate)],
      },
    });
  };

  // The campaign's own start date first, so nothing about the schedule
  // moves. The live API has refused schedules over start_date before
  // (first-campaign/api.ts); if it does here, today is the date that means
  // "carry on as you are".
  try {
    await write(schedule.startDate ?? todayIn(schedule.timezone));
  } catch (err) {
    const refusedDate =
      err instanceof PlusvibeError && err.status === 400 && /start_date/i.test(err.message) && !!schedule.startDate;
    if (!refusedDate) throw err;
    await write(todayIn(schedule.timezone));
  }

  // The PATCH response does not echo the schedule, so read it back.
  await acquireSlot();
  const after = (await fetchCampaignRaw(apiKey, workspaceId, campaignId)) as Record<string, unknown> | null;
  const got = readDailyLimit(after);
  if (got !== dailyLimit) {
    throw new Error(`written, but it read back as ${got === null ? "no limit" : got}`);
  }
}
