import "server-only";

import { plusvibePatch } from "@/lib/plusvibe-server";
import { acquireSlot } from "@/lib/jobs/rate-limit";
import {
  fetchCampaignRaw,
  fetchVariationFlags,
  normalizeSequences,
  splitDeleted,
  toWriteStep,
} from "@/lib/plusvibe-campaigns";
import { appendOptOutToStepOne } from "./append-opt-out";

// Writes the opt-out spintax onto every step-1 variation of one campaign.
//
// PATCH /campaign/update/campaign REPLACES the whole `sequences` array, so this
// is a strict read-modify-write: read the campaign, drop the variations
// Plusvibe considers deleted, append to step 1 only, write EVERY step back,
// then re-read to confirm.
//
// Sub-sequences are separate campaign records (campaign_type "subseq") with
// their own ids, so they are untouched simply by never being addressed here —
// which is exactly the requirement: step 1 of the parent, nothing else.

export interface ApplyOptOutResult {
  applied: string[];
  alreadyPresent: string[];
  droppedDeleted: number;
  verified: boolean;
}

export async function applyOptOutToCampaign(params: {
  apiKey: string;
  workspaceId: string;
  campaignId: string;
}): Promise<ApplyOptOutResult> {
  const { apiKey, workspaceId, campaignId } = params;

  await acquireSlot();
  const raw = await fetchCampaignRaw(apiKey, workspaceId, campaignId);
  if (!raw) throw new Error("Campaign not found");

  const rawSequences = normalizeSequences(raw.sequences);
  if (rawSequences.length === 0) {
    throw new Error("Campaign has no sequence steps");
  }
  if (!rawSequences.some((s) => s.step === 1)) {
    throw new Error("Campaign has no step 1");
  }

  // `sequences` keeps returning variations deleted in the Plusvibe UI, with no
  // flag to identify them. Writing them back resurrects them as live copy —
  // and duplicating a campaign is precisely what leaves them behind, so this
  // tool's input is the worst case for it.
  await acquireSlot();
  const flags = await fetchVariationFlags(apiKey, workspaceId, campaignId);
  let droppedDeleted = 0;
  const sequences = rawSequences.map((s) => {
    const { live, deleted } = splitDeleted(s.step, s.variations, flags);
    droppedDeleted += deleted.length;
    return { ...s, variations: live };
  });

  const stepOne = sequences.find((s) => s.step === 1);
  if (!stepOne || stepOne.variations.length === 0) {
    throw new Error("Step 1 has no live variations to add the opt-out line to");
  }

  const { steps, changed, alreadyPresent } = appendOptOutToStepOne(sequences);

  // Nothing to do — a resumed or repeated run. Skip the write entirely rather
  // than PATCHing identical content.
  if (changed.length === 0) {
    return {
      applied: [],
      alreadyPresent,
      droppedDeleted,
      verified: true,
    };
  }

  const payload: Record<string, unknown> = {
    workspace_id: workspaceId,
    campaign_id: campaignId,
    sequences: steps.map(toWriteStep),
  };
  // Sub-sequences must carry first_wait_time whenever sequences are sent. The
  // campaigns this tool touches are parents, but a mis-selection shouldn't
  // corrupt the wait time.
  if (String(raw.campaign_type ?? "") === "subseq") {
    payload.first_wait_time = raw.first_wait_time ?? 0;
    if (raw.first_wait_time_unit) {
      payload.first_wait_time_unit = raw.first_wait_time_unit;
    }
  }

  await acquireSlot();
  await plusvibePatch<unknown>({
    apiKey,
    path: "/campaign/update/campaign",
    body: payload,
  });

  // The PATCH response doesn't echo sequences, so confirm by re-reading.
  await acquireSlot();
  const after = await fetchCampaignRaw(apiKey, workspaceId, campaignId);
  const afterStepOne = after
    ? normalizeSequences(after.sequences).find((s) => s.step === 1)
    : undefined;
  const verified =
    !!afterStepOne &&
    afterStepOne.variations.length >= stepOne.variations.length &&
    afterStepOne.variations.every((v) => !changed.includes(v.variation) ||
      (v.body ?? "").includes("{{Random |"));

  return { applied: changed, alreadyPresent, droppedDeleted, verified };
}
