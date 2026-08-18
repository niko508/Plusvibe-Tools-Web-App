import { NextResponse } from "next/server";
import { plusvibePost, resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import {
  fetchCampaignLeads,
  leadToPayload,
  type LeadPayload,
} from "@/lib/plusvibe-leads";

export const dynamic = "force-dynamic";

const CHUNK = 100; // batch cap is undocumented; 100 keeps requests small
const MAX_MOVE = 5000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface AddResponse {
  leads_uploaded?: number;
  already_in_campaign?: number;
  skipped?: number;
  duplicate_email_count?: number;
  invalid_email_count?: number;
}

// POST /api/plusvibe/leads/move
// Body: { workspace_id, source_campaign_id, destination_campaign_id, count }
//
// There is no move endpoint, so each chunk is added to the destination and only
// then deleted from the source — and only if the add is confirmed. /lead/delete
// returns no per-email detail and is assumed irreversible, so an unverified add
// aborts the run rather than risking leads that exist in neither campaign.
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as {
      workspace_id?: string;
      source_campaign_id?: string;
      destination_campaign_id?: string;
      count?: number;
    };

    const workspace_id = body.workspace_id ? String(body.workspace_id) : "";
    const source = body.source_campaign_id ? String(body.source_campaign_id) : "";
    const destination = body.destination_campaign_id
      ? String(body.destination_campaign_id)
      : "";
    const count = Math.floor(Number(body.count));

    if (!workspace_id || !source || !destination) {
      return NextResponse.json(
        {
          error:
            "workspace_id, source_campaign_id and destination_campaign_id are required",
        },
        { status: 400 }
      );
    }
    if (source === destination) {
      return NextResponse.json(
        { error: "Source and destination must be different campaigns." },
        { status: 400 }
      );
    }
    if (!Number.isFinite(count) || count < 1) {
      return NextResponse.json(
        { error: "Enter how many leads to move (at least 1)." },
        { status: 400 }
      );
    }
    if (count > MAX_MOVE) {
      return NextResponse.json(
        { error: `Too many leads in one run (max ${MAX_MOVE}).` },
        { status: 400 }
      );
    }

    // --- Collect the leads to move ---------------------------------------
    const { leads } = await fetchCampaignLeads(
      apiKey,
      workspace_id,
      source,
      count
    );
    if (leads.length === 0) {
      return NextResponse.json(
        { error: "No leads found in the source campaign." },
        { status: 400 }
      );
    }

    const payloads: LeadPayload[] = leads
      .map(leadToPayload)
      .filter((p) => p.email);

    let added = 0;
    let alreadyThere = 0;
    let deleted = 0;
    const errors: string[] = [];
    let abortedAt: number | null = null;

    for (let i = 0; i < payloads.length; i += CHUNK) {
      const chunk = payloads.slice(i, i + CHUNK);
      if (i > 0) await sleep(240);

      // --- Add to destination --------------------------------------------
      let addRes: AddResponse;
      try {
        addRes = await plusvibePost<AddResponse>({
          apiKey,
          path: "/lead/add",
          body: {
            workspace_id,
            campaign_id: destination,
            // All three must be false: these leads are currently in the source
            // campaign, so leaving any skip flag on would silently skip the add
            // and the move would lose them at the delete step.
            skip_if_in_workspace: false,
            skip_lead_in_active_pause_camp: false,
            skip_lead_for_active_only_camp: false,
            resume_camp_if_completed: false,
            is_overwrite: false,
            leads: chunk,
          },
        });
      } catch (err) {
        errors.push(
          `Adding leads ${i + 1}–${i + chunk.length} failed: ${
            err instanceof Error ? err.message : "unknown error"
          }`
        );
        abortedAt = i;
        break;
      }

      const uploaded = Number(addRes?.leads_uploaded ?? 0) || 0;
      const existing = Number(addRes?.already_in_campaign ?? 0) || 0;
      const landed = uploaded + existing;
      added += uploaded;
      alreadyThere += existing;

      // --- Verify before deleting anything --------------------------------
      if (landed < chunk.length) {
        errors.push(
          `Only ${landed} of ${chunk.length} leads landed in the destination (uploaded ${uploaded}, already there ${existing}). Nothing was deleted from the source — the run stopped here so no leads are lost.`
        );
        abortedAt = i;
        break;
      }

      // --- Delete from source ---------------------------------------------
      await sleep(240);
      try {
        await plusvibePost<{ status?: string }>({
          apiKey,
          path: "/lead/delete",
          body: {
            workspace_id,
            campaign_id: source, // omitting this would delete workspace-wide
            delete_all_from_company: false, // would remove every lead at the domain
            delete_list: chunk.map((c) => c.email),
          },
        });
        deleted += chunk.length;
      } catch (err) {
        errors.push(
          `Leads ${i + 1}–${i + chunk.length} were added to the destination but could not be removed from the source: ${
            err instanceof Error ? err.message : "unknown error"
          }. They now exist in both campaigns.`
        );
        abortedAt = i;
        break;
      }
    }

    return NextResponse.json({
      requested: count,
      found: leads.length,
      added,
      alreadyInDestination: alreadyThere,
      deletedFromSource: deleted,
      errors,
      complete: abortedAt === null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
