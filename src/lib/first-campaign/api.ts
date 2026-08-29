import "server-only";

// The Plusvibe calls "New Workspace 1st Campaign" needs that nothing else uses:
// creating a campaign, creating a sub-sequence, and reading/creating lead
// labels. Kept together so the job runner reads as a sequence of steps rather
// than a wall of request plumbing.

import {
  plusvibeGet,
  plusvibePost,
  plusvibePatch,
  PlusvibeError,
} from "@/lib/plusvibe-server";
import { listTags, findTagByName } from "@/lib/plusvibe-tags";
import type { WorkspaceLabel } from "@/lib/first-campaign/labels";

/** Plusvibe ids are 24-hex; anything else is a bug on our side, not theirs. */
const ID_RE = /^[a-fA-F0-9]{24}$/;

function requireId(value: unknown, what: string): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!ID_RE.test(id)) {
    throw new Error(`Plusvibe did not return a usable ${what} id`);
  }
  return id;
}

// --- Campaigns --------------------------------------------------------------

/**
 * Creates an empty campaign shell.
 *
 * The endpoint takes only a name — steps, schedule, sending accounts and every
 * setting arrive later via PATCH.
 */
export async function createCampaign(
  apiKey: string,
  workspaceId: string,
  name: string
): Promise<string> {
  const res = await plusvibePost<Record<string, unknown>>({
    apiKey,
    path: "/campaign/add/campaign",
    body: { workspace_id: workspaceId, camp_name: name },
  });
  return requireId(res?.id, "campaign");
}

/**
 * Creates a sub-sequence under a parent campaign, with its trigger.
 *
 * `events` is required by the API — a sub-sequence with no trigger can't be
 * created, so the trigger is settled before this is called.
 */
export async function createSubsequence(
  apiKey: string,
  args: {
    workspaceId: string;
    parentCampaignId: string;
    name: string;
    events: Array<Record<string, unknown>>;
  }
): Promise<string> {
  const res = await plusvibePost<Record<string, unknown>>({
    apiKey,
    path: "/campaign/add/subsequence",
    body: {
      workspace_id: args.workspaceId,
      name: args.name,
      parent_camp_id: args.parentCampaignId,
      events: args.events,
    },
  });
  return requireId(res?.id, "subsequence");
}

/**
 * PATCHes a campaign or sub-sequence.
 *
 * The `schedules` shape is the one place the API docs contradict themselves:
 * the schema declares it an object, while the worked example in the same
 * document sends an array of one. Rather than guess, the object form is sent
 * first and an array retried on a 400 — the request is a partial update of the
 * same fields either way, so repeating it is harmless. Which form worked is
 * returned so the job can record it.
 */
export async function updateCampaign(
  apiKey: string,
  body: Record<string, unknown>
): Promise<{ scheduleForm?: "object" | "array" }> {
  const hasSchedule =
    body.schedules !== undefined && !Array.isArray(body.schedules);

  try {
    await plusvibePatch({
      apiKey,
      path: "/campaign/update/campaign",
      body,
    });
    return hasSchedule ? { scheduleForm: "object" } : {};
  } catch (err) {
    const isBadRequest = err instanceof PlusvibeError && err.status === 400;
    if (!isBadRequest || !hasSchedule) throw err;

    await plusvibePatch({
      apiKey,
      path: "/campaign/update/campaign",
      body: { ...body, schedules: [body.schedules] },
    });
    return { scheduleForm: "array" };
  }
}

/**
 * The sub-sequences already under a parent campaign.
 *
 * Used as a reuse guard: creating a sub-sequence is not idempotent, so a second
 * run over the same campaign would otherwise leave six duplicates behind.
 */
export async function listSubsequences(
  apiKey: string,
  workspaceId: string,
  parentCampaignId: string
): Promise<Array<{ id: string; name: string }>> {
  const data = await plusvibeGet<unknown>({
    apiKey,
    path: "/campaign/list-all",
    query: {
      workspace_id: workspaceId,
      parent_camp_id: parentCampaignId,
      campaign_type: "subseq",
      limit: "100",
    },
  });
  const raw = Array.isArray(data)
    ? (data as Array<Record<string, unknown>>)
    : Array.isArray((data as { campaigns?: unknown })?.campaigns)
      ? ((data as { campaigns: Array<Record<string, unknown>> }).campaigns)
      : [];
  return raw
    .map((c) => ({
      id: String(c.id ?? c._id ?? "").trim(),
      name: String(c.camp_name ?? c.name ?? "").trim(),
    }))
    .filter((c) => c.id && c.name);
}

// --- Lead labels ------------------------------------------------------------

interface RawLabel {
  id?: string | null;
  key?: string;
  name?: string;
  is_system?: number;
}

/** Every label in the workspace: system labels and custom ones alike. */
export async function listLeadLabels(
  apiKey: string,
  workspaceId: string
): Promise<WorkspaceLabel[]> {
  const data = await plusvibeGet<unknown>({
    apiKey,
    path: "/workspace-settings/lead-labels",
    query: { workspace_id: workspaceId },
  });
  const raw: RawLabel[] = Array.isArray(data)
    ? (data as RawLabel[])
    : Array.isArray((data as { labels?: unknown })?.labels)
      ? ((data as { labels: RawLabel[] }).labels)
      : [];
  return raw
    .map((l) => ({
      key: String(l.key ?? ""),
      name: String(l.name ?? ""),
      isSystem: l.is_system === 1,
    }))
    .filter((l) => l.name);
}

/**
 * Creates a custom lead label and returns the key the API generated for it.
 *
 * The key is always taken from the response — the documented derivation rule
 * ("letters/numbers kept, everything else becomes `_`") is not safe to
 * reimplement for names carrying emoji, whose UTF-16 length varies.
 */
export async function addLeadLabel(
  apiKey: string,
  args: {
    workspaceId: string;
    name: string;
    sentiment: "POSITIVE" | "NEGATIVE" | "NEUTRAL";
  }
): Promise<{ key: string; name: string }> {
  const res = await plusvibePost<Record<string, unknown>>({
    apiKey,
    path: "/workspace-settings/lead-labels/add",
    body: {
      workspace_id: args.workspaceId,
      name: args.name,
      sentiment: args.sentiment,
    },
  });
  const key = typeof res?.key === "string" ? res.key.trim() : "";
  if (!key) {
    throw new Error(`Plusvibe created "${args.name}" but returned no label key`);
  }
  return { key, name: String(res?.name ?? args.name) };
}

// --- Tags -------------------------------------------------------------------

/**
 * Resolves a tag name to its id, for use as a sending-account entry.
 *
 * `email_accounts` accepts tag ids alongside account ids, so attaching the
 * "Active" tag keeps the campaign's senders in step with the tag rather than
 * freezing today's account list into it.
 */
export async function findTagId(
  apiKey: string,
  workspaceId: string,
  tagName: string
): Promise<string | null> {
  const tags = await listTags(apiKey, workspaceId);
  return findTagByName(tags, tagName)?.id ?? null;
}
