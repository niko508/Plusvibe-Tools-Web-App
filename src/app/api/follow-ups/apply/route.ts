import { NextResponse } from "next/server";
import { plusvibePatch, resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import {
  fetchCampaignRaw,
  fetchVariationFlags,
  normalizeSequences,
  splitDeleted,
  toWriteStep,
  MAX_VARIATIONS_PER_STEP,
  nextVariationLabels,
} from "@/lib/plusvibe-campaigns";
import { renderTemplates } from "@/lib/follow-ups/templates";
import type { FollowUpTemplate } from "@/lib/follow-ups/templates";
import type { SequenceStep, SequenceVariation } from "@/lib/plusvibe-types";

export const dynamic = "force-dynamic";

// Follow-ups always land on step 2 of the parent campaign.
const FOLLOW_UP_STEP = 2;
const DEFAULT_WAIT_TIME = 3;

// POST /api/follow-ups/apply
// Body: { workspace_id, campaign_id, offer, templates, waitTime?, dryRun? }
//
// Writes each template as a variation of step 2, substituting the offer.
// PATCH /campaign/update/campaign REPLACES the whole `sequences` array, so this
// re-reads the campaign, merges into step 2 (creating it when the campaign only
// has step 1), writes every step back, then re-reads to confirm.
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as {
      workspace_id?: string;
      campaign_id?: string;
      offer?: string;
      templates?: FollowUpTemplate[];
      waitTime?: number;
      dryRun?: boolean;
    };

    const workspace_id = String(body.workspace_id ?? "");
    const campaign_id = String(body.campaign_id ?? "");
    const offer = String(body.offer ?? "").trim();
    const templates = Array.isArray(body.templates) ? body.templates : [];

    if (!workspace_id || !campaign_id) {
      return NextResponse.json(
        { error: "workspace_id and campaign_id are required" },
        { status: 400 }
      );
    }
    if (!offer) {
      return NextResponse.json(
        {
          error:
            "Enter the service offering / offer sentence — it replaces the placeholder in every template.",
        },
        { status: 400 }
      );
    }
    if (templates.length === 0) {
      return NextResponse.json(
        { error: "No templates to add. Add some in the Templates view first." },
        { status: 400 }
      );
    }

    const { rendered, warnings } = renderTemplates(templates, offer);
    if (rendered.length === 0) {
      return NextResponse.json(
        { error: "Every template is empty." },
        { status: 400 }
      );
    }

    // --- Read current state ------------------------------------------------
    const raw = await fetchCampaignRaw(apiKey, workspace_id, campaign_id);
    if (!raw) {
      return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
    }
    const rawSequences = normalizeSequences(raw.sequences);
    if (!rawSequences.some((s) => s.step === 1)) {
      return NextResponse.json(
        {
          error:
            "This campaign has no step 1. Add the first email in Plusvibe before adding follow-ups.",
        },
        { status: 400 }
      );
    }

    // `sequences` keeps returning variations deleted in the Plusvibe UI, with no
    // flag to identify them. Writing them back resurrects them as live copy, so
    // drop them from EVERY step before doing anything else.
    const flags = await fetchVariationFlags(apiKey, workspace_id, campaign_id);
    let droppedDeleted = 0;
    const sequences = rawSequences.map((s) => {
      const { live, deleted } = splitDeleted(s.step, s.variations, flags);
      droppedDeleted += deleted.length;
      return { ...s, variations: live };
    });

    const existingStep = sequences.find((s) => s.step === FOLLOW_UP_STEP);
    const stepCreated = !existingStep;
    const target: SequenceStep = existingStep ?? {
      step: FOLLOW_UP_STEP,
      wait_time:
        Number.isFinite(body.waitTime) && Number(body.waitTime) >= 0
          ? Number(body.waitTime)
          : DEFAULT_WAIT_TIME,
      variations: [],
    };

    // --- Skip anything already there ---------------------------------------
    // Appending accumulates: re-running the same library would double the
    // follow-ups. Comparing normalized bodies makes a repeat run a no-op.
    const existingKeys = new Set(
      target.variations.map((v) => bodyKey(v.body ?? ""))
    );
    const fresh: typeof rendered = [];
    const skipped: number[] = [];
    for (const r of rendered) {
      const key = bodyKey(r.html);
      if (existingKeys.has(key)) {
        skipped.push(r.position);
        continue;
      }
      existingKeys.add(key);
      fresh.push(r);
    }

    // --- Allocate labels ---------------------------------------------------
    // Disabled variations can be missing from `sequences` yet still hold their
    // letter, so reserve those too; letters freed by DELETED ones are reusable.
    const stepFlags = flags.get(FOLLOW_UP_STEP);
    const disabledLabels = stepFlags
      ? Array.from(stepFlags.entries())
          .filter(([, f]) => !f.isDel)
          .map(([label]) => label)
      : [];
    const used = new Set<string>([
      ...target.variations.map((v) => v.variation),
      ...disabledLabels,
    ]);
    const remaining = MAX_VARIATIONS_PER_STEP - used.size;
    if (fresh.length > remaining) {
      return NextResponse.json(
        {
          error: `Step ${FOLLOW_UP_STEP} can hold ${MAX_VARIATIONS_PER_STEP} variations and already uses ${used.size}. Only ${Math.max(
            0,
            remaining
          )} more can be added — remove some templates or clear out old variants first.`,
        },
        { status: 400 }
      );
    }

    const labels = nextVariationLabels(used, fresh.length);
    const added: SequenceVariation[] = fresh.map((r, i) => ({
      variation: labels[i],
      // Follow-ups reply into the step 1 thread, so the subject stays empty.
      subject: "",
      preheader: "",
      name: `Follow-up ${r.position}`,
      body: r.html,
    }));

    const plan = {
      campaignName: String(raw.name ?? ""),
      step: FOLLOW_UP_STEP,
      stepCreated,
      waitTime: target.wait_time ?? DEFAULT_WAIT_TIME,
      existing: target.variations.length,
      adding: added.map((a, i) => ({
        variation: a.variation,
        name: a.name,
        position: fresh[i].position,
        replacements: fresh[i].replacements,
        preview: preview(fresh[i].body),
      })),
      skipped,
      droppedDeleted,
      warnings,
    };

    if (body.dryRun) {
      return NextResponse.json({ ...plan, applied: false, verified: true });
    }

    if (added.length === 0) {
      return NextResponse.json({
        ...plan,
        applied: false,
        verified: true,
        unchanged: true,
      });
    }

    // --- Write every step back, step 2 extended ----------------------------
    const merged: SequenceStep[] = existingStep
      ? sequences.map((s) =>
          s.step === FOLLOW_UP_STEP
            ? { ...s, variations: [...s.variations, ...added] }
            : s
        )
      : [...sequences, { ...target, variations: added }].sort(
          (a, b) => a.step - b.step
        );

    const payload: Record<string, unknown> = {
      workspace_id,
      campaign_id,
      sequences: merged.map(toWriteStep),
    };
    // Sub-sequences must carry first_wait_time whenever sequences are sent.
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

    // --- Verify (the PATCH response doesn't echo sequences) ----------------
    const after = await fetchCampaignRaw(apiKey, workspace_id, campaign_id);
    const afterStep = after
      ? normalizeSequences(after.sequences).find((s) => s.step === FOLLOW_UP_STEP)
      : undefined;
    const expected = target.variations.length + added.length;
    const actual = afterStep?.variations.length ?? 0;

    return NextResponse.json({
      ...plan,
      applied: true,
      expected,
      actual,
      verified: actual === expected,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Normalized body key, so trivial whitespace differences aren't "new". */
function bodyKey(html: string): string {
  return html.replace(/\s+/g, " ").trim().toLowerCase();
}

function preview(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
