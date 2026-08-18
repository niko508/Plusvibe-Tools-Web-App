import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { createJobs, countRunning } from "@/lib/jobs/move-leads";
import type { MovePair, MoveLeadsStartPayload } from "@/lib/jobs/move-leads-types";
import { MAX_PAIRS, MAX_PER_PAIR } from "@/lib/jobs/move-leads-types";

export const dynamic = "force-dynamic";

// POST /api/jobs/move-leads/start
// Body: { workspaceId, workspaceName, pairs: [{sourceCampaignId, sourceName,
//         destinationCampaignId, destinationName, count}] }
// Starts one background job per pair. Returns { jobIds }.
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as Partial<MoveLeadsStartPayload>;

    const workspaceId = body.workspaceId ? String(body.workspaceId) : "";
    if (!workspaceId) {
      return NextResponse.json(
        { error: "workspaceId is required" },
        { status: 400 }
      );
    }

    const rawPairs = Array.isArray(body.pairs) ? body.pairs : [];
    const pairs: MovePair[] = [];
    for (const p of rawPairs) {
      if (!p?.sourceCampaignId || !p?.destinationCampaignId) continue;
      const count = Math.floor(Number(p.count));
      if (!Number.isFinite(count) || count < 1) {
        return NextResponse.json(
          { error: "Every pair needs a lead count of at least 1." },
          { status: 400 }
        );
      }
      if (count > MAX_PER_PAIR) {
        return NextResponse.json(
          { error: `Too many leads in one pair (max ${MAX_PER_PAIR}).` },
          { status: 400 }
        );
      }
      if (String(p.sourceCampaignId) === String(p.destinationCampaignId)) {
        return NextResponse.json(
          { error: "Source and destination must be different campaigns." },
          { status: 400 }
        );
      }
      pairs.push({
        sourceCampaignId: String(p.sourceCampaignId),
        sourceName: String(p.sourceName ?? ""),
        destinationCampaignId: String(p.destinationCampaignId),
        destinationName: String(p.destinationName ?? ""),
        count,
      });
    }

    if (pairs.length === 0) {
      return NextResponse.json(
        { error: "Add at least one source → destination pair." },
        { status: 400 }
      );
    }
    if (pairs.length > MAX_PAIRS) {
      return NextResponse.json(
        { error: `At most ${MAX_PAIRS} pairs can be started at once.` },
        { status: 400 }
      );
    }

    // The same source twice would have both jobs racing for the same leads.
    const sources = new Set(pairs.map((p) => p.sourceCampaignId));
    if (sources.size !== pairs.length) {
      return NextResponse.json(
        {
          error:
            "Each source campaign can only appear once — two jobs reading the same source would move the same leads twice.",
        },
        { status: 400 }
      );
    }

    const running = await countRunning(apiKey);
    if (running + pairs.length > MAX_PAIRS) {
      return NextResponse.json(
        {
          error: `${running} move job${running === 1 ? " is" : "s are"} already running. At most ${MAX_PAIRS} run at once — wait for one to finish or abort it.`,
        },
        { status: 409 }
      );
    }

    const jobIds = await createJobs(apiKey, {
      workspaceId,
      workspaceName: String(body.workspaceName ?? ""),
      pairs,
    });
    return NextResponse.json({ jobIds });
  } catch (err) {
    return errorResponse(err);
  }
}
