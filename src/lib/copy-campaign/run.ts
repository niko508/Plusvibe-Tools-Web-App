import "server-only";

import { plusvibePatch, plusvibePost } from "@/lib/plusvibe-server";
import { acquireSlot } from "@/lib/jobs/rate-limit";
import {
  fetchCampaignRaw,
  fetchVariationFlags,
  listCampaigns,
  normalizeSequences,
  splitDeleted,
  toWriteStep,
} from "@/lib/plusvibe-campaigns";
import type { SequenceStep } from "@/lib/plusvibe-types";
import { compareShapes, countVariations, shapeOf } from "./plan";

// The whole copy, server-side, in one pass.
//
// Order matters. The source is read FIRST: if its copy can't be read there is
// nothing to write, and failing before the duplicate exists leaves no orphan
// draft behind. Only once the content is in hand is the destination campaign
// duplicated and then overwritten.

export interface CopyCampaignInput {
  apiKey: string;
  sourceWorkspaceId: string;
  sourceCampaignId: string;
  destWorkspaceId: string;
  destCampaignId: string;
  name: string;
  /** Bring the destination campaign's sub-sequences across. Default true. */
  duplicateSubsequences?: boolean;
}

export interface CopyCampaignResult {
  createdId: string;
  name: string;
  /** Steps and variations taken from the source. */
  stepsCopied: number;
  variationsCopied: number;
  /** Variations Plusvibe still returns for the source but has deleted. */
  droppedDeleted: number;
  /** Sub-sequences found under the copy afterwards. */
  subsequences: number;
  /** The copy read back and matched what was sent. */
  verified: boolean;
  problems: string[];
  warnings: string[];
}

/**
 * Thrown when the copy exists but could not be filled in. It carries the new
 * campaign's id so the caller can name it — an orphan draft the user doesn't
 * know about is the one genuinely bad outcome here.
 */
export class PartialCopyError extends Error {
  constructor(
    readonly createdId: string,
    readonly createdName: string,
    readonly cause: string
  ) {
    super(
      `The copy "${createdName}" was created in the destination workspace, but its content could not be written: ${cause}. ` +
        `It is a draft — delete it in Plusvibe, or run the copy again and delete the empty one.`
    );
    this.name = "PartialCopyError";
  }
}

export async function copyCampaign(
  input: CopyCampaignInput
): Promise<CopyCampaignResult> {
  const {
    apiKey,
    sourceWorkspaceId,
    sourceCampaignId,
    destWorkspaceId,
    destCampaignId,
  } = input;
  const name = input.name.trim();
  const warnings: string[] = [];

  // --- 1. The source's copy, with deleted variations dropped ---------------
  const sourceRaw = await fetchCampaignRaw(
    apiKey,
    sourceWorkspaceId,
    sourceCampaignId
  );
  if (!sourceRaw) throw new Error("The source campaign could not be read.");

  const flags = await fetchVariationFlags(
    apiKey,
    sourceWorkspaceId,
    sourceCampaignId
  );
  let droppedDeleted = 0;
  const liveSteps: SequenceStep[] = [];
  for (const step of normalizeSequences(sourceRaw.sequences)) {
    const { live, deleted } = splitDeleted(step.step, step.variations, flags);
    droppedDeleted += deleted.length;
    if (live.length === 0) {
      warnings.push(
        `Step ${step.step} has no live variations on the source, so it is copied as an empty step.`
      );
    }
    liveSteps.push({ ...step, variations: live });
  }
  if (liveSteps.length === 0) {
    throw new Error(
      "The source campaign has no sequence steps, so there is nothing to copy."
    );
  }
  const expected = shapeOf(liveSteps);
  if (droppedDeleted > 0) {
    warnings.push(
      `${droppedDeleted} variation${droppedDeleted === 1 ? "" : "s"} deleted in Plusvibe ${droppedDeleted === 1 ? "was" : "were"} left out of the copy.`
    );
  }

  // --- 2. Duplicate the destination campaign, in its own workspace ---------
  await acquireSlot();
  const dup = await plusvibePost<{ status?: string; id?: string }>({
    apiKey,
    path: "/campaign/duplicate",
    body: {
      workspace_id: destWorkspaceId,
      campaign_id: destCampaignId,
      camp_name: name,
      duplicate_subsequences: input.duplicateSubsequences === false ? "no" : "yes",
    },
  });
  const createdId = typeof dup?.id === "string" ? dup.id.trim() : "";
  if (!createdId) {
    // A blind retry would risk a second copy, so this fails loudly.
    throw new Error(
      `Duplicating "${name}" returned no campaign id (status: ${dup?.status ?? "unknown"}). Check Plusvibe — the copy may exist.`
    );
  }

  // --- 3. Write the source's copy over the new campaign's parent -----------
  try {
    await acquireSlot();
    await plusvibePatch<unknown>({
      apiKey,
      path: "/campaign/update/campaign",
      body: {
        workspace_id: destWorkspaceId,
        campaign_id: createdId,
        sequences: liveSteps.map(toWriteStep),
      },
    });
  } catch (err) {
    throw new PartialCopyError(
      createdId,
      name,
      err instanceof Error ? err.message : "the update was refused"
    );
  }

  // --- 4. Prove it, since the update call echoes nothing -------------------
  const problems: string[] = [];
  let verified = false;
  try {
    await acquireSlot();
    const after = await fetchCampaignRaw(apiKey, destWorkspaceId, createdId);
    const actual = shapeOf(normalizeSequences(after?.sequences));
    const check = compareShapes(expected, actual);
    verified = check.ok;
    problems.push(...check.problems);
  } catch (err) {
    problems.push(
      `The copy was written but could not be read back to check it: ${err instanceof Error ? err.message : "read failed"}.`
    );
  }

  // --- 5. Count what came across with the duplicate ------------------------
  let subsequences = 0;
  try {
    await acquireSlot();
    const subs = await listCampaigns(apiKey, destWorkspaceId, {
      campaignType: "subseq",
    });
    subsequences = subs.filter((c) => c.parentCampId === createdId).length;
  } catch {
    // Only a count for the report; a failure here is not worth an error.
  }

  return {
    createdId,
    name,
    stepsCopied: expected.length,
    variationsCopied: countVariations(expected),
    droppedDeleted,
    subsequences,
    verified,
    problems,
    warnings,
  };
}
