import "server-only";

import { plusvibePost } from "@/lib/plusvibe-server";
import { acquireSlot } from "@/lib/jobs/rate-limit";

// Campaign duplication and activation.
//
//   POST /campaign/duplicate  { workspace_id, campaign_id, camp_name,
//                               duplicate_subsequences }
//     Copies sequences, schedule, settings and sender accounts into a new
//     DRAFT campaign. Leads and statistics are not copied, which is what this
//     tool wants — the lead split is done deliberately in a later phase.
//
//   POST /campaign/launch     { workspace_id, campaign_id,
//                               activate_subsequences }
//     Activates the campaign, and its draft subsequences when asked.

interface DuplicateResponse {
  status?: string;
  id?: string;
}

/**
 * Duplicates a campaign under a new name and returns the new campaign's id.
 *
 * `duplicate_subsequences` is sent explicitly rather than relying on the
 * documented default: the whole point of this step is that the sub-sequences
 * come across, so it should not depend on a default that could change.
 */
export async function duplicateCampaign(params: {
  apiKey: string;
  workspaceId: string;
  sourceCampaignId: string;
  newName: string;
}): Promise<string> {
  await acquireSlot();
  const data = await plusvibePost<DuplicateResponse>({
    apiKey: params.apiKey,
    path: "/campaign/duplicate",
    body: {
      workspace_id: params.workspaceId,
      campaign_id: params.sourceCampaignId,
      camp_name: params.newName,
      duplicate_subsequences: "yes",
    },
  });

  const id = typeof data?.id === "string" ? data.id.trim() : "";
  if (!id) {
    // Without an id we can't address the copy for the opt-out edit, the lead
    // move or the launch — and a blind retry would create a second copy. Fail
    // loudly instead.
    throw new Error(
      `Duplicate of "${params.newName}" returned no campaign id (status: ${
        data?.status ?? "unknown"
      }). Check Plusvibe — the copy may exist.`
    );
  }
  return id;
}

/**
 * Activates a campaign and, by default, its draft sub-sequences.
 *
 * Per the docs a sub-sequence can only start once its parent has, so parents
 * are always launched with activate_subsequences rather than launching
 * sub-sequences separately.
 */
export async function launchCampaign(params: {
  apiKey: string;
  workspaceId: string;
  campaignId: string;
}): Promise<void> {
  await acquireSlot();
  await plusvibePost<{ status?: string }>({
    apiKey: params.apiKey,
    path: "/campaign/launch",
    body: {
      workspace_id: params.workspaceId,
      campaign_id: params.campaignId,
      activate_subsequences: "yes",
    },
  });
}
