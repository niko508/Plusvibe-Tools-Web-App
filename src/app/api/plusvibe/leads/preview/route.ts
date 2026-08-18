import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import {
  fetchCampaignLeads,
  fetchStatusCounts,
  leadToPayload,
  totalCount,
} from "@/lib/plusvibe-leads";

export const dynamic = "force-dynamic";

const SAMPLE_SIZE = 100; // one page — enough to see which variables are typical

// GET /api/plusvibe/leads/preview?workspace_id=…&campaign_id=…
// Pre-flight for a move: how many leads the source holds, and exactly which
// fields would be carried across for a sample lead — so it's visible up front
// whether personalization (opening_line etc.) survives.
export async function GET(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const { searchParams } = new URL(request.url);
    const workspace_id = searchParams.get("workspace_id");
    const campaign_id = searchParams.get("campaign_id");
    if (!workspace_id || !campaign_id) {
      return NextResponse.json(
        { error: "workspace_id and campaign_id are required" },
        { status: 400 }
      );
    }

    const counts = await fetchStatusCounts(apiKey, workspace_id, campaign_id);
    const available = totalCount(counts);

    // Sample a page rather than a single lead: a variable present on most
    // leads but missing from the first one would otherwise look absent.
    const { leads } = await fetchCampaignLeads(
      apiKey,
      workspace_id,
      campaign_id,
      SAMPLE_SIZE
    );

    const topLevel = new Set<string>();
    // Present = the lead carries the field at all; filled = it has a value.
    // Both matter: a variable on every lead but empty on most is worth seeing.
    const present = new Map<string, number>();
    const filled = new Map<string, number>();
    for (const lead of leads) {
      const payload = leadToPayload(lead);
      for (const key of Object.keys(payload)) {
        if (key !== "custom_variables") topLevel.add(key);
      }
      for (const [key, value] of Object.entries(payload.custom_variables ?? {})) {
        present.set(key, (present.get(key) ?? 0) + 1);
        if (String(value ?? "").trim() !== "") {
          filled.set(key, (filled.get(key) ?? 0) + 1);
        }
      }
    }

    return NextResponse.json({
      available,
      counts,
      sample:
        leads.length > 0
          ? {
              sampled: leads.length,
              topLevelFields: Array.from(topLevel),
              // Most common first, so the important variables lead.
              customVariables: Array.from(present.entries())
                .map(([name, count]) => ({
                  name,
                  count,
                  filled: filled.get(name) ?? 0,
                }))
                .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
            }
          : null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
