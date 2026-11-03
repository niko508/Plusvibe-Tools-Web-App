import "server-only";

import { plusvibeGet, plusvibePatch, plusvibePost } from "@/lib/plusvibe-server";
import { acquireSlot } from "@/lib/jobs/rate-limit";
import { fetchCampaignRaw, listCampaigns, normalizeSequences, toWriteStep } from "@/lib/plusvibe-campaigns";
import { listTags, type Tag } from "@/lib/plusvibe-tags";
import { resolveTag } from "@/lib/inbox-tags/api";
import { assignCampaignTag, tagIdsOf, unassignCampaignTag } from "@/lib/campaign-types/tag-campaigns";
import { compareShapes, shapeOf } from "@/lib/copy-campaign/plan";
import { optOutState } from "@/lib/campaign-types/append-opt-out";
import {
  anchorsOf,
  creditStepOne,
  followUpPositives,
  matchQuoted,
  stepOneOf,
  textKey,
  type SentEmail,
  cleanTagName,
  parseVariationStats,
  planMultiWinners,
  planWinners,
  type CampaignInput,
  tagChanges,
  type CloneResult,
  type OptOutChoice,
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

/** At most this many campaigns' winners in one clone. */
export const MAX_WINNER_CAMPAIGNS = 20;

const nameOf = (raw: Record<string, unknown>) => String(raw.camp_name ?? raw.name ?? "").trim() || "(untitled)";

/**
 * The plan for the base campaign alone, or with the winners of the others —
 * every campaign read, figures and all, before anything is decided. Without a
 * campaign's stats nothing of it can be judged, so a failure stops it rather
 * than guessing.
 */
async function planFor(
  apiKey: string,
  workspaceId: string,
  campaignId: string,
  alsoIds: string[],
  optOut: OptOutChoice = "keep"
): Promise<{ raw: Record<string, unknown>; plan: WinnerPlan; credit: FollowUpCredit }> {
  const credit: FollowUpCredit = { credited: 0, untraced: 0 };
  const labels: { keys: string[] | null } = { keys: null };
  const raw = await readCampaign(apiKey, workspaceId, campaignId);
  const stats = await creditedStats(apiKey, workspaceId, campaignId, raw, await readStats(apiKey, workspaceId, campaignId), labels, credit);
  const others = [...new Set(alsoIds)].filter((id) => id && id !== campaignId).slice(0, MAX_WINNER_CAMPAIGNS - 1);
  if (others.length === 0) return { raw, plan: planWinners(normalizeSequences(raw.sequences), stats, optOut), credit };
  const base: CampaignInput = { id: campaignId, name: nameOf(raw), sequence: normalizeSequences(raw.sequences), stats };
  const inputs: CampaignInput[] = [base];
  for (const id of others) {
    const r = await readCampaign(apiKey, workspaceId, id);
    const st = await creditedStats(apiKey, workspaceId, id, r, await readStats(apiKey, workspaceId, id), labels, credit);
    inputs.push({ id, name: nameOf(r), sequence: normalizeSequences(r.sequences), stats: st });
  }
  return { raw, plan: planMultiWinners(base, inputs, optOut), credit };
}

// --- Positive replies to follow-ups, credited to the first email ----------

export interface FollowUpCredit {
  /** Positive replies to follow-ups added to the step-1 variant the lead was sent. */
  credited: number;
  /** Positive replies Plusvibe gives a follow-up that couldn't be traced to a first email. */
  untraced: number;
}

const asList = (data: unknown): Record<string, unknown>[] =>
  Array.isArray(data) ? (data as Record<string, unknown>[]) : Array.isArray((data as { data?: unknown })?.data) ? ((data as { data: Record<string, unknown>[] }).data) : [];

const bodyText = (body: unknown): string => {
  if (typeof body === "string") return body;
  const b = (body ?? {}) as { html?: string; text?: string };
  return b.html || b.text || "";
};

/** The workspace's positive labels — Plusvibe's own and every custom one marked positive. */
async function positiveLabelKeys(apiKey: string, workspaceId: string, cache: { keys: string[] | null }): Promise<string[]> {
  if (cache.keys) return cache.keys;
  await acquireSlot();
  const labels = asList(await plusvibeGet<unknown>({ apiKey, path: "/workspace-settings/lead-labels", query: { workspace_id: workspaceId } }));
  cache.keys = labels.filter((l) => String(l.sentiment ?? "").toUpperCase() === "POSITIVE").map((l) => String(l.key ?? "")).filter(Boolean);
  return cache.keys;
}

/**
 * The campaign's figures with every positive reply to a follow-up added to
 * the step-1 variant that lead was sent. Only campaigns Plusvibe says have
 * such replies are looked into, so the rest cost nothing extra.
 */
async function creditedStats(
  apiKey: string,
  workspaceId: string,
  campaignId: string,
  raw: Record<string, unknown>,
  stats: StatsByStep,
  labels: { keys: string[] | null },
  tally: FollowUpCredit
): Promise<StatsByStep> {
  const owed = followUpPositives(stats);
  if (owed === 0) return stats;
  const sequence = normalizeSequences(raw.sequences).sort((a, b) => a.step - b.step);
  const firstStep = sequence[0]?.step ?? 1;
  const stepOneVariants = (sequence[0]?.variations ?? []).map((v) => ({ variation: v.variation, body: v.body ?? "" }));
  const followUpAnchors = sequence.slice(1).flatMap((s) => s.variations.flatMap((v) => anchorsOf(v.body ?? "")));

  // Every positive thread of this campaign, whatever positive label it has
  // now: the campaign's threads read once and sorted here, rather than one
  // read per label.
  const positive = new Set(await positiveLabelKeys(apiKey, workspaceId, labels));
  const threads = new Map<string, Record<string, unknown>>();
  let trail = "";
  for (let page = 0; page < 60; page++) {
    await acquireSlot();
    const r = await plusvibeGet<{ data?: unknown; page_trail?: string }>({
      apiKey,
      path: "/unibox/threads",
      query: { workspace_id: workspaceId, campaign_id: campaignId, limit: "100", page_trail: trail || undefined },
    });
    for (const t of asList(r)) if (t.thread_id && positive.has(String(t.label ?? ""))) threads.set(String(t.thread_id), t);
    trail = String(r?.page_trail ?? "");
    if (!trail) break;
  }

  const credits = new Map<string, number>();
  let traced = 0;
  // A few threads at a time: each needs two reads, and the shared rate limit
  // still spaces every request start.
  const queue = [...threads.values()];
  const worker = async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      const found = await traceThread(t);
      if (!found) continue;
      credits.set(found, (credits.get(found) ?? 0) + 1);
      traced += 1;
    }
  };
  /** The step-1 variant a positive reply to a follow-up is credited to; null when it isn't one, or can't be told. */
  async function traceThread(t: Record<string, unknown>): Promise<string | null> {
    await acquireSlot();
    const emails = asList(await plusvibeGet<unknown>({ apiKey, path: "/unibox/emails", query: { workspace_id: workspaceId, thread_id: String(t.thread_id) } }));
    const reply = emails
      .filter((e) => String(e.direction ?? "").toUpperCase() === "IN")
      .sort((a, b) => Date.parse(String(a.timestamp_created)) - Date.parse(String(b.timestamp_created)))[0];
    if (!reply) return null;
    const lead = String(t.lead ?? "").trim();
    let sent: SentEmail[] = [];
    if (lead) {
      await acquireSlot();
      sent = asList(await plusvibeGet<unknown>({ apiKey, path: "/unibox/campaign-emails", query: { workspace_id: workspaceId, lead, campaign_id: campaignId } }))
        .map((e) => ({ step: Number(e.current_step), variation: String(e.variation ?? ""), sentAt: Date.parse(String(e.sent_on)) }))
        .filter((e) => e.step > 0 && e.variation);
    }
    if (sent.length > 0) {
      const r = stepOneOf(sent, Date.parse(String(reply.timestamp_created)));
      // A yes to step 1 itself is already Plusvibe's step-1 figure.
      return r.repliedStep > firstStep ? r.stepOne : null;
    }
    // A lead deleted since: its reply quotes what it answered.
    const text = bodyText(reply.body);
    const hay = ` ${textKey(text)} `;
    if (!followUpAnchors.some((a) => hay.includes(` ${a} `))) return null;
    return matchQuoted(text, stepOneVariants);
  }
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
  tally.credited += traced;
  tally.untraced += Math.max(0, owed - traced);
  return creditStepOne(stats, credits, firstStep);
}

export async function previewWinners(apiKey: string, workspaceId: string, campaignId: string, alsoIds: string[] = []): Promise<WinnersPreview> {
  const { raw, plan, credit } = await planFor(apiKey, workspaceId, campaignId, alsoIds);
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
    followUps: credit,
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
  /** The opt-out line on the kept variants: added, taken out, or left as each has it. */
  optOut: OptOutChoice;
  /** Other campaigns in the workspace whose step-1 winners join the clone's. */
  alsoIds?: string[];
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
  const { plan } = await planFor(apiKey, workspaceId, campaignId, input.alsoIds ?? [], input.optOut);
  if (plan.steps.length === 0) throw new Error("That campaign has no sequence steps, so there is nothing to clone.");
  if (plan.noWinners && !input.confirmEmpty) throw new NeedsConfirmError();
  if (plan.overLimit) warnings.push(`${plan.overLimit} more winning variant${plan.overLimit === 1 ? "" : "s"} didn't fit in one step and ${plan.overLimit === 1 ? "was" : "were"} left out — the weakest.`);
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
    // The opt-out line, variant by variant, as chosen.
    if (!plan.noWinners && input.optOut !== "keep") {
      const firstAfter = normalizeSequences(after.sequences).sort((a, b) => a.step - b.step)[0];
      const want = input.optOut === "add" ? "current" : "none";
      const off = (firstAfter?.variations ?? []).filter((v) => (v.body ?? "").trim() && optOutState(v.body ?? "") !== want).map((v) => v.variation);
      if (off.length > 0) {
        problems.push(
          `Variant${off.length === 1 ? "" : "s"} ${off.join(", ")} ${input.optOut === "add" ? "didn't come back with the opt-out line" : "still carr" + (off.length === 1 ? "ies" : "y") + " opt-out text"}.`
        );
      }
    }
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
