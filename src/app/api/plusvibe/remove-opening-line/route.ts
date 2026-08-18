import { NextResponse } from "next/server";
import { plusvibePatch, resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import {
  fetchCampaignRaw,
  fetchVariationFlags,
  normalizeSequences,
  splitDeleted,
  toWriteStep,
} from "@/lib/plusvibe-campaigns";
import { stripOpeningLine, stripSubjectFallback } from "@/lib/opening-line";
import type { SequenceVariation } from "@/lib/plusvibe-types";

export const dynamic = "force-dynamic";

// POST /api/plusvibe/remove-opening-line
// Body: { workspace_id, campaign_id, dryRun?: boolean }
//
// Unwraps `{{fallback| {{subject_line}} | … }}` from every subject and removes
// `{{opening_line}}` from every body, leaving the copy otherwise untouched.
// dryRun runs the identical code path without writing, so the preview is
// exactly what an apply would do.
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as {
      workspace_id?: string;
      campaign_id?: string;
      dryRun?: boolean;
    };

    const workspace_id = body.workspace_id ? String(body.workspace_id) : "";
    const campaign_id = body.campaign_id ? String(body.campaign_id) : "";
    if (!workspace_id || !campaign_id) {
      return NextResponse.json(
        { error: "workspace_id and campaign_id are required" },
        { status: 400 }
      );
    }
    const dryRun = body.dryRun === true;

    const raw = await fetchCampaignRaw(apiKey, workspace_id, campaign_id);
    if (!raw) {
      return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
    }

    // Same as the other write path: variations Plusvibe deleted can linger in
    // `sequences`, and writing them back would resurrect them.
    const flags = await fetchVariationFlags(apiKey, workspace_id, campaign_id);
    const sequences = normalizeSequences(raw.sequences).map((s) => {
      const { live } = splitDeleted(s.step, s.variations, flags);
      return { ...s, variations: live };
    });

    if (sequences.length === 0) {
      return NextResponse.json(
        { error: "This campaign has no sequence steps." },
        { status: 400 }
      );
    }

    const rows: PlanRow[] = [];
    let subjectsChanged = 0;
    let bodiesChanged = 0;
    let openingLinesRemoved = 0;
    let subjectSample: { before: string; after: string } | undefined;

    const transformed = sequences.map((s) => ({
      ...s,
      variations: s.variations.map((v): SequenceVariation => {
        const subj = stripSubjectFallback(v.subject ?? "");
        const bod = stripOpeningLine(v.body ?? "");
        if (subj.changed) {
          subjectsChanged += 1;
          if (!subjectSample) {
            subjectSample = { before: v.subject ?? "", after: subj.result };
          }
        }
        if (bod.changed) {
          bodiesChanged += 1;
          openingLinesRemoved += bod.removed;
        }
        rows.push({
          step: s.step,
          variation: v.variation,
          subjectChanged: subj.changed,
          bodyChanged: bod.changed,
          removed: bod.removed,
        });
        return { ...v, subject: subj.result, body: bod.result };
      }),
    }));

    const totals = {
      variations: rows.length,
      subjectsChanged,
      bodiesChanged,
      openingLinesRemoved,
    };

    if (dryRun) {
      return NextResponse.json({
        campaignName: String(raw.camp_name ?? raw.name ?? ""),
        rows,
        totals,
        subjectSample,
        applied: false,
      });
    }

    if (subjectsChanged === 0 && bodiesChanged === 0) {
      return NextResponse.json({
        campaignName: String(raw.camp_name ?? raw.name ?? ""),
        rows,
        totals,
        subjectSample,
        applied: false,
        verified: true,
      });
    }

    const payload: Record<string, unknown> = {
      workspace_id,
      campaign_id,
      sequences: transformed.map(toWriteStep),
    };
    if (String(raw.campaign_type ?? "") === "subseq") {
      payload.first_wait_time = raw.first_wait_time ?? 0;
      if (raw.first_wait_time_unit) {
        payload.first_wait_time_unit = raw.first_wait_time_unit;
      }
    }

    await plusvibePatch<unknown>({
      apiKey,
      path: "/campaign/update/campaign",
      body: payload,
    });

    // The PATCH response doesn't echo sequences, so confirm with a fresh read:
    // nothing should still carry a fallback wrapper or an opening line.
    const after = await fetchCampaignRaw(apiKey, workspace_id, campaign_id);
    let leftover = 0;
    if (after) {
      for (const s of normalizeSequences(after.sequences)) {
        const { live } = splitDeleted(s.step, s.variations, flags);
        for (const v of live) {
          if (
            stripSubjectFallback(v.subject ?? "").changed ||
            stripOpeningLine(v.body ?? "").changed
          ) {
            leftover += 1;
          }
        }
      }
    }

    return NextResponse.json({
      campaignName: String(raw.camp_name ?? raw.name ?? ""),
      rows,
      totals,
      subjectSample,
      applied: true,
      leftover,
      verified: leftover === 0,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

interface PlanRow {
  step: number;
  variation: string;
  subjectChanged: boolean;
  bodyChanged: boolean;
  removed: number;
}
