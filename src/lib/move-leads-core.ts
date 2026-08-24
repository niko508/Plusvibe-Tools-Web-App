import "server-only";

import { plusvibePost } from "@/lib/plusvibe-server";
import { acquireSlot } from "@/lib/jobs/rate-limit";
import type { LeadPayload } from "@/lib/plusvibe-leads";

// The add → verify → delete move, shared by Move Leads and Create All Campaign
// Types.
//
// There is no move endpoint. A move is POST /lead/add into the destination
// followed by POST /lead/delete from the source (keyed by EMAIL). /lead/delete
// gives no per-email result and is treated as irreversible, so the add is
// VERIFIED before anything is deleted: a partial add stops the caller rather
// than risking leads that exist in neither campaign.

export const MOVE_CHUNK = 100;

interface AddResponse {
  leads_uploaded?: number;
  already_in_campaign?: number;
}

export type MoveChunkOutcome =
  | { ok: true; uploaded: number; alreadyThere: number; deleted: number }
  | { ok: false; stage: "add" | "verify" | "delete"; reason: string };

/**
 * Moves one chunk of leads. Returns a structured outcome instead of throwing so
 * the caller can record exactly which stage failed — the three failure modes
 * have very different consequences:
 *
 *   add     nothing happened; safe to retry
 *   verify  nothing was deleted; leads are intact in the source
 *   delete  leads now exist in BOTH campaigns and need manual cleanup
 */
export async function moveLeadChunk(params: {
  apiKey: string;
  workspaceId: string;
  sourceCampaignId: string;
  destinationCampaignId: string;
  chunk: LeadPayload[];
  isAborted: () => boolean;
}): Promise<MoveChunkOutcome> {
  const {
    apiKey,
    workspaceId,
    sourceCampaignId,
    destinationCampaignId,
    chunk,
  } = params;

  await acquireSlot();
  if (params.isAborted()) return { ok: false, stage: "add", reason: "aborted" };

  let addRes: AddResponse;
  try {
    addRes = await plusvibePost<AddResponse>({
      apiKey,
      path: "/lead/add",
      body: {
        workspace_id: workspaceId,
        campaign_id: destinationCampaignId,
        // Every skip flag off: these leads are currently in the source
        // campaign, so any skip would drop the add and the delete below would
        // then lose them.
        skip_if_in_workspace: false,
        skip_lead_in_active_pause_camp: false,
        skip_lead_for_active_only_camp: false,
        resume_camp_if_completed: false,
        is_overwrite: false,
        leads: chunk,
      },
    });
  } catch (err) {
    return { ok: false, stage: "add", reason: message(err) };
  }

  const uploaded = Number(addRes?.leads_uploaded ?? 0) || 0;
  const alreadyThere = Number(addRes?.already_in_campaign ?? 0) || 0;
  const landed = uploaded + alreadyThere;

  if (landed < chunk.length) {
    return {
      ok: false,
      stage: "verify",
      reason: `only ${landed} of ${chunk.length} leads landed in the destination (uploaded ${uploaded}, already there ${alreadyThere}) — nothing was deleted from the source`,
    };
  }

  await acquireSlot();
  if (params.isAborted()) {
    // The add already succeeded. Stopping here would leave the chunk in both
    // campaigns, so the delete still runs; the caller aborts on the next turn.
  }

  try {
    await plusvibePost<{ status?: string }>({
      apiKey,
      path: "/lead/delete",
      body: {
        workspace_id: workspaceId,
        campaign_id: sourceCampaignId, // omitting this deletes workspace-wide
        delete_all_from_company: false,
        delete_list: chunk.map((c) => c.email),
      },
    });
  } catch (err) {
    return {
      ok: false,
      stage: "delete",
      reason: `${message(err)} — these leads were added to the destination but are still in the source, so they now exist in both`,
    };
  }

  return { ok: true, uploaded, alreadyThere, deleted: chunk.length };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}
