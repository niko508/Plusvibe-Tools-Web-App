import { NextResponse } from "next/server";
import { plusvibePatch, resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import {
  MAX_VARIATIONS_PER_STEP,
  fetchCampaignRaw,
  fetchVariationFlags,
  nextVariationLabels,
  normalizeSequences,
  splitDeleted,
  toWriteStep,
} from "@/lib/plusvibe-campaigns";
import type { SequenceVariation } from "@/lib/plusvibe-types";

export const dynamic = "force-dynamic";

const MAX_NEW_VARIANTS = 104;

interface IncomingVariant {
  name?: string;
  body?: string;
}

// POST /api/plusvibe/campaign-variations
// Body: { workspace_id, campaign_id, step, variants: [{name, body}],
//         expectedVariationCount? }
//
// Appends variants to one sequence step. PATCH /campaign/update/campaign
// REPLACES the whole `sequences` array, so this re-reads the campaign here
// (rather than trusting client state), merges the new variants into the target
// step, writes every step back untouched, then re-reads to confirm.
export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as {
      workspace_id?: string;
      campaign_id?: string;
      step?: number;
      variants?: IncomingVariant[];
      expectedVariationCount?: number;
      keepVariations?: string[];
    };

    const workspace_id = body.workspace_id ? String(body.workspace_id) : "";
    const campaign_id = body.campaign_id ? String(body.campaign_id) : "";
    const step = Number(body.step);
    if (!workspace_id || !campaign_id || !Number.isFinite(step) || step < 1) {
      return NextResponse.json(
        { error: "workspace_id, campaign_id and step are required" },
        { status: 400 }
      );
    }

    const incoming = (Array.isArray(body.variants) ? body.variants : [])
      .map((v) => ({ name: String(v?.name ?? ""), body: String(v?.body ?? "") }))
      .filter((v) => v.body.trim());
    if (incoming.length === 0) {
      return NextResponse.json(
        { error: "No variants with a body were provided." },
        { status: 400 }
      );
    }
    if (incoming.length > MAX_NEW_VARIANTS) {
      return NextResponse.json(
        { error: `Too many variants in one request (max ${MAX_NEW_VARIANTS}).` },
        { status: 400 }
      );
    }

    // --- Read current state ------------------------------------------------
    const raw = await fetchCampaignRaw(apiKey, workspace_id, campaign_id);
    if (!raw) {
      return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
    }
    const rawSequences = normalizeSequences(raw.sequences);
    if (rawSequences.length === 0) {
      return NextResponse.json(
        { error: "This campaign has no sequence steps to add variants to." },
        { status: 400 }
      );
    }

    // `sequences` keeps returning variations that were deleted in Plusvibe, and
    // carries no flag to identify them. Writing them back resurrects them as
    // live copy, so drop them from EVERY step before doing anything else.
    const flags = await fetchVariationFlags(apiKey, workspace_id, campaign_id);
    let droppedDeleted = 0;
    const sequences = rawSequences.map((s) => {
      const { live, deleted } = splitDeleted(s.step, s.variations, flags);
      droppedDeleted += deleted.length;
      return { ...s, variations: live };
    });

    const target = sequences.find((s) => s.step === step);
    if (!target) {
      return NextResponse.json(
        { error: `Step ${step} not found on this campaign.` },
        { status: 400 }
      );
    }

    // Guard against acting on a stale preview (someone edited the step since).
    // Compared before the keep-filter, since that's the count the client saw.
    if (
      typeof body.expectedVariationCount === "number" &&
      body.expectedVariationCount !== target.variations.length
    ) {
      return NextResponse.json(
        {
          error: `Step ${step} now has ${target.variations.length} variations but the preview was built from ${body.expectedVariationCount}. Reload the campaign and try again.`,
        },
        { status: 409 }
      );
    }

    // variation-stats only knows about variations that have sent something, so
    // on a never-launched campaign it can't identify stale ones at all. When the
    // caller says explicitly which letters to keep on the target step, that wins
    // — it's the only reliable signal for a draft.
    const liveBefore = target.variations.length;
    let droppedByChoice = 0;
    if (Array.isArray(body.keepVariations)) {
      const keep = new Set(
        body.keepVariations.map((l) => String(l).toUpperCase())
      );
      target.variations = target.variations.filter((v) =>
        keep.has(v.variation.toUpperCase())
      );
      droppedByChoice = liveBefore - target.variations.length;
    }

    // --- Skip anything already on the step --------------------------------
    // Appending is destructive-by-accumulation: re-running the same paste would
    // silently double the copy. Comparing normalized bodies makes a repeat run a
    // no-op, and also collapses duplicates inside the batch itself.
    const existingKeys = new Set(
      target.variations.map((v) => bodyKey(v.body ?? ""))
    );
    const fresh: IncomingVariant[] = [];
    const skipped: string[] = [];
    for (const v of incoming) {
      const key = bodyKey(v.body ?? "");
      if (!key || existingKeys.has(key)) {
        skipped.push(v.name || "(unnamed)");
        continue;
      }
      existingKeys.add(key);
      fresh.push(v);
    }

    if (fresh.length === 0) {
      return NextResponse.json({
        added: [],
        skipped,
        subject: target.variations.find((v) => v.subject)?.subject ?? "",
        step,
        before: target.variations.length,
        expected: target.variations.length,
        actual: target.variations.length,
        verified: true,
      });
    }

    // --- Allocate labels ---------------------------------------------------
    // Reserve letters held by live variations and by disabled ones (which can be
    // missing from `sequences` yet still occupy a letter). Letters belonging to
    // DELETED variations are free again, so new variants can reuse them.
    const stepFlags = flags.get(step);
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
          error: `Step ${step} can hold ${MAX_VARIATIONS_PER_STEP} variations and already uses ${used.size}. Only ${Math.max(
            0,
            remaining
          )} more can be added.`,
        },
        { status: 400 }
      );
    }
    const labels = nextVariationLabels(used, fresh.length);

    // Keep the step's existing subject/preheader on the new variants.
    const source = target.variations.find((v) => v.subject) ?? target.variations[0];
    const subject = source?.subject ?? "";
    const preheader = source?.preheader ?? "";
    if (step === 1 && !subject) {
      return NextResponse.json(
        {
          error:
            "Step 1 has no subject line to copy — set one on the existing variant in Plusvibe first (the API requires a subject on step 1).",
        },
        { status: 400 }
      );
    }

    const added: SequenceVariation[] = fresh.map((v, i) => ({
      variation: labels[i],
      subject,
      preheader,
      name: v.name ?? "",
      body: v.body ?? "",
    }));

    // --- Write every step back, target step extended -----------------------
    const writeSequences = sequences.map((s) =>
      s.step === step
        ? toWriteStep({ ...s, variations: [...s.variations, ...added] })
        : toWriteStep(s)
    );

    const payload: Record<string, unknown> = {
      workspace_id,
      campaign_id,
      sequences: writeSequences,
    };
    // Subsequences must carry first_wait_time whenever sequences are sent.
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
      ? normalizeSequences(after.sequences).find((s) => s.step === step)
      : undefined;
    const expected = target.variations.length + added.length;
    const actual = afterStep?.variations.length ?? 0;

    return NextResponse.json({
      added: added.map((v) => ({ variation: v.variation, name: v.name })),
      skipped,
      droppedDeleted,
      droppedByChoice,
      subject,
      step,
      before: liveBefore,
      expected,
      actual,
      verified: actual === expected,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

// Normalized body used to detect a variant that's already on the step: strip
// tags and entities so formatting differences don't defeat the comparison.
function bodyKey(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
