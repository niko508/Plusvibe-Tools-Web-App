import "server-only";

import { plusvibeGet, plusvibePost } from "@/lib/plusvibe-server";
import { acquireSlot } from "@/lib/jobs/rate-limit";
import type { LeadPayload } from "@/lib/plusvibe-leads";
import {
  accountFor,
  prepareChunk,
  readAddCounts,
  type UnmovedLead,
  type UnmovedReason,
} from "@/lib/move-leads-plan";

// The add → verify → delete move used by Create All Campaign Types.
//
// There is no move endpoint. A move is POST /lead/add into the destination
// followed by POST /lead/delete from the source (keyed by EMAIL). /lead/delete
// gives no per-email result and is treated as irreversible, so nothing is
// deleted from the source until it is known to be in the destination.
//
// /lead/add can turn a lead away — a repeated address in the batch, an
// address that isn't one, the plan's quota — and says so only as COUNTS, never
// which. So the batch is cleaned first (the two commonest refusals are found
// here), and when the count still comes up short every lead is confirmed in
// the destination one by one: the confirmed are deleted from the source, the
// missing are tried again singly, and whatever still won't land stays in the
// source and is named. A refused lead is never a reason to stop the run.

export const MOVE_CHUNK = 100;

export type MoveChunkOutcome =
  | {
      ok: true;
      uploaded: number;
      alreadyThere: number;
      /** Deleted from the source, which is what "moved" means. */
      deleted: number;
      /** Left in the source, each with why. */
      unmoved: UnmovedLead[];
      /** How many had to be confirmed by email rather than by the count. */
      confirmedIndividually: number;
      /** The plan's lead quota turned leads away; later chunks will too. */
      quotaHit: boolean;
    }
  | { ok: false; stage: "add" | "delete"; reason: string; unmoved: UnmovedLead[] };

/**
 * Moves one chunk of leads. Returns a structured outcome instead of throwing so
 * the caller can record exactly what happened — the failure modes have very
 * different consequences:
 *
 *   add     nothing happened; safe to retry
 *   delete  leads now exist in BOTH campaigns and need manual cleanup
 *
 * A short count is not a failure: it is settled lead by lead.
 */
export async function moveLeadChunk(params: {
  apiKey: string;
  workspaceId: string;
  sourceCampaignId: string;
  destinationCampaignId: string;
  chunk: LeadPayload[];
  isAborted: () => boolean;
}): Promise<MoveChunkOutcome> {
  const { apiKey, workspaceId, sourceCampaignId, destinationCampaignId, chunk } = params;

  const { send, unmoved } = prepareChunk(chunk);
  if (send.length === 0) {
    return { ok: true, uploaded: 0, alreadyThere: 0, deleted: 0, unmoved, confirmedIndividually: 0, quotaHit: false };
  }

  await acquireSlot();
  if (params.isAborted()) return { ok: false, stage: "add", reason: "aborted", unmoved };

  let raw: Record<string, unknown>;
  try {
    raw = await addLeads(apiKey, workspaceId, destinationCampaignId, send);
  } catch (err) {
    return { ok: false, stage: "add", reason: message(err), unmoved };
  }

  const counts = readAddCounts(raw);
  const account = accountFor(send.length, counts);

  let toDelete: LeadPayload[];
  let confirmedIndividually = 0;
  if (account.complete) {
    toDelete = send;
  } else {
    // Some were turned away and the API won't say which. Confirm each lead in
    // the destination; anything not there is tried once more on its own.
    const confirmed: LeadPayload[] = [];
    const missing: LeadPayload[] = [];
    for (const lead of send) {
      await acquireSlot();
      (await leadInCampaign(apiKey, workspaceId, destinationCampaignId, lead.email))
        ? confirmed.push(lead)
        : missing.push(lead);
    }
    confirmedIndividually = confirmed.length;

    for (const lead of missing) {
      if (account.quotaHit) {
        // No point retrying into a full plan; the caller stops the split.
        unmoved.push({ email: lead.email, reason: "overflow" });
        continue;
      }
      await acquireSlot();
      let single;
      try {
        single = readAddCounts(await addLeads(apiKey, workspaceId, destinationCampaignId, [lead]));
      } catch (err) {
        unmoved.push({ email: lead.email, reason: "add-failed", detail: message(err) });
        continue;
      }
      if (single.uploaded + single.alreadyThere >= 1) {
        confirmed.push(lead);
        continue;
      }
      unmoved.push({ email: lead.email, reason: reasonFromCounts(single) });
    }
    toDelete = confirmed;
  }

  if (toDelete.length === 0) {
    return {
      ok: true,
      uploaded: counts.uploaded,
      alreadyThere: counts.alreadyThere,
      deleted: 0,
      unmoved,
      confirmedIndividually,
      quotaHit: account.quotaHit,
    };
  }

  await acquireSlot();
  // An abort here is deliberately ignored: the add already succeeded, and
  // stopping now would leave the chunk in both campaigns. The caller aborts on
  // its next turn.
  try {
    await plusvibePost<{ status?: string }>({
      apiKey,
      path: "/lead/delete",
      body: {
        workspace_id: workspaceId,
        campaign_id: sourceCampaignId, // omitting this deletes workspace-wide
        delete_all_from_company: false,
        delete_list: toDelete.map((c) => c.email),
      },
    });
  } catch (err) {
    return {
      ok: false,
      stage: "delete",
      reason: `${message(err)} — these leads were added to the destination but are still in the source, so they now exist in both`,
      unmoved,
    };
  }

  return {
    ok: true,
    uploaded: counts.uploaded,
    alreadyThere: counts.alreadyThere,
    deleted: toDelete.length,
    unmoved,
    confirmedIndividually,
    quotaHit: account.quotaHit,
  };
}

async function addLeads(
  apiKey: string,
  workspaceId: string,
  campaignId: string,
  leads: LeadPayload[]
): Promise<Record<string, unknown>> {
  return plusvibePost<Record<string, unknown>>({
    apiKey,
    path: "/lead/add",
    body: {
      workspace_id: workspaceId,
      campaign_id: campaignId,
      // Every skip flag off: these leads are currently in the source campaign,
      // so any skip would drop the add and the delete would then lose them.
      skip_if_in_workspace: false,
      skip_lead_in_active_pause_camp: false,
      skip_lead_for_active_only_camp: false,
      resume_camp_if_completed: false,
      is_overwrite: false,
      leads,
    },
  });
}

/**
 * Whether a lead is in a campaign, by email.
 *
 * Anything short of a clear yes is a no — an error, an empty body, a different
 * address — because a "no" leaves the lead in the source, which is the safe
 * side to be wrong on.
 */
async function leadInCampaign(
  apiKey: string,
  workspaceId: string,
  campaignId: string,
  email: string
): Promise<boolean> {
  try {
    const data = await plusvibeGet<unknown>({
      apiKey,
      path: "/lead/get",
      query: { workspace_id: workspaceId, campaign_id: campaignId, email },
    });
    return mentions(data, email);
  } catch {
    return false;
  }
}

function mentions(data: unknown, email: string): boolean {
  const want = email.trim().toLowerCase();
  const items: unknown[] = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { leads?: unknown }).leads)
      ? ((data as { leads: unknown[] }).leads)
      : [data];
  return items.some((it) => {
    if (!it || typeof it !== "object") return false;
    const o = it as Record<string, unknown>;
    const lead = (o.lead_data ?? {}) as Record<string, unknown>;
    return [o.contact, o.email, lead.email].some(
      (v) => typeof v === "string" && v.trim().toLowerCase() === want
    );
  });
}

function reasonFromCounts(c: ReturnType<typeof readAddCounts>): UnmovedReason {
  if (c.overflow > 0) return "overflow";
  if (c.invalid > 0) return "invalid-email";
  if (c.duplicate > 0) return "duplicate";
  if (c.skipped > 0) return "rejected";
  return "not-confirmed";
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}
