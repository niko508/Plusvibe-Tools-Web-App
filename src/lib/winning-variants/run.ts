import "server-only";

import { plusvibeGet, plusvibePatch, plusvibePost } from "@/lib/plusvibe-server";
import { acquireSlot } from "@/lib/jobs/rate-limit";
import { fetchCampaignRaw, listCampaigns, normalizeSequences, toWriteStep } from "@/lib/plusvibe-campaigns";
import { listTags, type Tag } from "@/lib/plusvibe-tags";
import { resolveTag } from "@/lib/inbox-tags/api";
import { assignCampaignTag, tagIdsOf, unassignCampaignTag } from "@/lib/campaign-types/tag-campaigns";
import { compareShapes, shapeOf } from "@/lib/copy-campaign/plan";
import {
  cleanTagName,
  parseVariationStats,
  planWinners,
  tagChanges,
  type CloneResult,
  type PlanSummary,
  type StatsByStep,
  type WinnerPlan,
  type WinnersPreview,
} from "./plan";

// Clone Campaign with Winning Variants, server-side.
//
// Everything is read before anything is created: the campaign, its all-time
// variation stats and its tags. Then the campaign is duplicated in its own
// workspace — settings, schedule, sender accounts and sub-sequences come with
// it — its sequence is rewritten with only step 1's winners (the follow-ups as
// they are), its tags are brought to the chosen set, and the result is read
// back to prove it.

const NEW_TAG_COLOR = "#6366f1";

export type { CloneResult, WinnersPreview };

async function readStats(apiKey: string, workspaceId: string, campaignId: string): Promise<StatsByStep> {
  await acquireSlot();
  const data = await plusvibeGet<unknown>({
    apiKey,
    path: "/campaign/get/variation-stats",
    query: { workspace_id: workspaceId, campaign_id: campaignId },
  });
  return parseVariationStats(data);
}

async function readCampaign(apiKey: string, workspaceId: string, campaignId: string) {
  await acquireSlot();
  const raw = await fetchCampaignRaw(apiKey, workspaceId, campaignId);
  if (!raw) throw new Error("That campaign could not be read.");
  return raw;
}

const summarizePlan = ({ steps: _steps, ...rest }: WinnerPlan): PlanSummary => rest;

export async function previewWinners(apiKey: string, workspaceId: string, campaignId: string): Promise<WinnersPreview> {
  const raw = await readCampaign(apiKey, workspaceId, campaignId);
  // Without the stats nothing can be judged, so this fails rather than
  // guessing — a clone built on no figures would keep or drop at random.
  const stats = await readStats(apiKey, workspaceId, campaignId);
  const plan = planWinners(normalizeSequences(raw.sequences), stats);
  await acquireSlot();
  const workspaceTags = await listTags(apiKey, workspaceId);
  const byId = new Map(workspaceTags.map((t) => [t.id, t]));
  const tags = tagIdsOf(raw).map((id) => byId.get(id) ?? { id, name: id });
  let subsequences = 0;
  try {
    await acquireSlot();
    subsequences = (await listCampaigns(apiKey, workspaceId, { campaignType: "subseq" })).filter((c) => c.parentCampId === campaignId).length;
  } catch {
    // Only a count for the preview.
  }
  return {
    campaignName: String(raw.camp_name ?? raw.name ?? "").trim() || "(untitled)",
    status: String(raw.status ?? "").toUpperCase(),
    plan: summarizePlan(plan),
    tags,
    workspaceTags,
    subsequences,
  };
}

export interface CloneInput {
  apiKey: string;
  workspaceId: string;
  campaignId: string;
  name: string;
  /** The tags the clone should carry, by id. */
  tagIds: string[];
  /** New tags to create and put on the clone, by name. */
  newTags: string[];
  /** Given once the page has warned that step 1 has no winners. */
  confirmEmpty: boolean;
}

/** Step 1 has no winners and the page hasn't said the user knows. */
export class NeedsConfirmError extends Error {
  constructor() {
    super("No variant in step 1 has a positive reply. Confirm to create the clone with one empty step-1 variant.");
    this.name = "NeedsConfirmError";
  }
}

/** The clone exists, but its sequence couldn't be written: it must be named. */
export class PartialCloneError extends Error {
  constructor(
    readonly createdId: string,
    readonly createdName: string,
    cause: string
  ) {
    super(
      `The clone "${createdName}" was created, but its sequence could not be written: ${cause}. ` +
        `It is a draft with ALL the original variants — delete it in Plusvibe, or fix it by hand.`
    );
    this.name = "PartialCloneError";
  }
}

export async function cloneWithWinners(input: CloneInput): Promise<CloneResult> {
  const { apiKey, workspaceId, campaignId } = input;
  const name = input.name.trim();
  const warnings: string[] = [];

  // --- 1. Read it all first: a failure here leaves nothing behind ---------
  const raw = await readCampaign(apiKey, workspaceId, campaignId);
  const stats = await readStats(apiKey, workspaceId, campaignId);
  const plan = planWinners(normalizeSequences(raw.sequences), stats);
  if (plan.steps.length === 0) throw new Error("That campaign has no sequence steps, so there is nothing to clone.");
  if (plan.noWinners && !input.confirmEmpty) throw new NeedsConfirmError();
  if (plan.noWinners) warnings.push(`No variant in step ${plan.firstStep} had a positive reply, so it was left as one empty variant for you to write.`);
  if (plan.droppedDeleted > 0) {
    warnings.push(`${plan.droppedDeleted} variant${plan.droppedDeleted === 1 ? "" : "s"} deleted in Plusvibe ${plan.droppedDeleted === 1 ? "was" : "were"} left out.`);
  }
  await acquireSlot();
  const workspaceTags = await listTags(apiKey, workspaceId);

  // --- 2. Duplicate it where it is, sub-sequences and all ------------------
  await acquireSlot();
  const dup = await plusvibePost<{ status?: string; id?: string }>({
    apiKey,
    path: "/campaign/duplicate",
    body: { workspace_id: workspaceId, campaign_id: campaignId, camp_name: name, duplicate_subsequences: "yes" },
  });
  const createdId = typeof dup?.id === "string" ? dup.id.trim() : "";
  if (!createdId) {
    // A blind retry could make a second clone, so this stops here.
    throw new Error(`Duplicating returned no campaign id (status: ${dup?.status ?? "unknown"}). Check Plusvibe — the clone may exist.`);
  }

  // --- 3. Only the winners in step 1; the follow-ups as they are ----------
  try {
    await acquireSlot();
    await plusvibePatch<unknown>({
      apiKey,
      path: "/campaign/update/campaign",
      body: { workspace_id: workspaceId, campaign_id: createdId, sequences: plan.steps.map(toWriteStep) },
    });
  } catch (err) {
    throw new PartialCloneError(createdId, name, err instanceof Error ? err.message : "the update was refused");
  }

  // --- 4. Tags: the chosen set, new ones created ---------------------------
  const createdTags: string[] = [];
  const wanted = new Set(input.tagIds.filter((id) => workspaceTags.some((t) => t.id === id)));
  const known = [...workspaceTags];
  for (const n of input.newTags) {
    const tagName = cleanTagName(n);
    if (!tagName) continue;
    try {
      const r = await resolveTag(apiKey, workspaceId, known, tagName, NEW_TAG_COLOR);
      wanted.add(r.id);
      if (r.created) {
        createdTags.push(tagName);
        known.push({ id: r.id, name: tagName, color: NEW_TAG_COLOR });
      }
    } catch (err) {
      warnings.push(`The tag "${tagName}" could not be created: ${err instanceof Error ? err.message : "failed"}.`);
    }
  }
  const problems: string[] = [];
  let finalTags: Tag[] = [];
  let verified = false;
  try {
    const clone = await readCampaign(apiKey, workspaceId, createdId);
    const change = tagChanges(tagIdsOf(clone), [...wanted]);
    for (const id of change.add) await assignCampaignTag(apiKey, workspaceId, [createdId], id);
    for (const id of change.remove) await unassignCampaignTag(apiKey, workspaceId, [createdId], id);

    // --- 5. Read it back: the update calls echo nothing -------------------
    const after = await readCampaign(apiKey, workspaceId, createdId);
    const check = compareShapes(shapeOf(plan.steps), shapeOf(normalizeSequences(after.sequences)));
    problems.push(...check.problems);
    const byId = new Map(known.map((t) => [t.id, t]));
    const onClone = tagIdsOf(after);
    finalTags = onClone.map((id) => byId.get(id) ?? { id, name: id });
    const tagCheck = tagChanges(onClone, [...wanted]);
    if (tagCheck.add.length + tagCheck.remove.length > 0) {
      problems.push(`The clone's tags didn't come out as chosen: ${[
        ...tagCheck.add.map((id) => `missing ${byId.get(id)?.name ?? id}`),
        ...tagCheck.remove.map((id) => `still has ${byId.get(id)?.name ?? id}`),
      ].join(", ")}.`);
    }
    verified = problems.length === 0;
  } catch (err) {
    problems.push(`The clone was made, but its tags or its read-back failed: ${err instanceof Error ? err.message : "failed"}.`);
  }

  let subsequences = 0;
  try {
    await acquireSlot();
    subsequences = (await listCampaigns(apiKey, workspaceId, { campaignType: "subseq" })).filter((c) => c.parentCampId === createdId).length;
  } catch {
    // Only a count for the report.
  }

  return { createdId, name, plan: summarizePlan(plan), subsequences, tags: finalTags, createdTags, verified, problems, warnings };
}
