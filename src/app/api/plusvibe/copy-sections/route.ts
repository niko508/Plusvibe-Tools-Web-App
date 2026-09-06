import { NextResponse } from "next/server";
import { plusvibePatch, resolveApiKey } from "@/lib/plusvibe-server";
import { errorResponse } from "@/lib/api-response";
import { acquireSlot } from "@/lib/jobs/rate-limit";
import {
  fetchCampaignRaw,
  fetchVariationFlags,
  normalizeSequences,
  splitDeleted,
  toWriteStep,
  bodyPreview,
} from "@/lib/plusvibe-campaigns";
import {
  applyEdit,
  blockText,
  validateEdit,
  type CopyEdit,
} from "@/lib/copy-sections/edit";

export const dynamic = "force-dynamic";

// POST /api/plusvibe/copy-sections
// Body: { workspace_id, campaign_id, step, edit, dryRun?, expectedVariationCount? }
//
// Applies one edit to every live variation of a step. PATCH
// /campaign/update/campaign REPLACES the whole `sequences` array, so this
// re-reads the campaign, drops variations Plusvibe has deleted, edits the
// target step, writes EVERY step back, then re-reads to confirm.
//
// A dry run returns the per-variation before/after without writing.

export interface SectionResult {
  variation: string;
  changed: boolean;
  reason?: string;
  subjectBefore: string;
  subjectAfter: string;
  bodyBefore: string;
  bodyAfter: string;
  /** Plain-text snippets for the table. */
  textBefore: string;
  textAfter: string;
  subjectMatches: number;
  bodyMatches: number;
}

export async function POST(request: Request) {
  try {
    const apiKey = resolveApiKey(request);
    const body = (await request.json()) as {
      workspace_id?: string;
      campaign_id?: string;
      step?: number;
      edit?: CopyEdit;
      dryRun?: boolean;
      expectedVariationCount?: number;
    };

    const workspace_id = String(body.workspace_id ?? "");
    const campaign_id = String(body.campaign_id ?? "");
    const step = Number(body.step);
    if (!workspace_id || !campaign_id || !Number.isFinite(step) || step < 1) {
      return NextResponse.json(
        { error: "workspace_id, campaign_id and step are required" },
        { status: 400 }
      );
    }
    const edit = sanitizeEdit(body.edit);
    if (!edit) {
      return NextResponse.json({ error: "Missing or invalid edit." }, { status: 400 });
    }
    // --- Read current state ------------------------------------------------
    await acquireSlot();
    const raw = await fetchCampaignRaw(apiKey, workspace_id, campaign_id);
    if (!raw) {
      return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
    }
    const subsequence = String(raw.campaign_type ?? "") === "subseq";
    const problems = validateEdit(edit, step, { subsequence });
    if (problems.length > 0) {
      return NextResponse.json({ error: problems.join(" ") }, { status: 400 });
    }
    const rawSequences = normalizeSequences(raw.sequences);
    await acquireSlot();
    const flags = await fetchVariationFlags(apiKey, workspace_id, campaign_id);
    let droppedDeleted = 0;
    const sequences = rawSequences.map((s) => {
      const { live, deleted } = splitDeleted(s.step, s.variations, flags);
      droppedDeleted += deleted.length;
      return { ...s, variations: live };
    });
    const target = sequences.find((s) => s.step === step);
    if (!target) {
      return NextResponse.json({ error: `Step ${step} not found on this campaign.` }, { status: 400 });
    }
    if (
      typeof body.expectedVariationCount === "number" &&
      body.expectedVariationCount !== target.variations.length
    ) {
      return NextResponse.json(
        {
          error: `Step ${step} now has ${target.variations.length} variations but the preview was built from ${body.expectedVariationCount}. Preview again before applying.`,
        },
        { status: 409 }
      );
    }

    // --- Apply to each variation ------------------------------------------
    const results: SectionResult[] = target.variations.map((v) => {
      const before = { variation: v.variation, subject: v.subject ?? "", body: v.body ?? "" };
      const r = applyEdit(before, edit);
      return {
        variation: v.variation,
        changed: r.changed,
        reason: r.reason,
        subjectBefore: before.subject,
        subjectAfter: r.subject,
        bodyBefore: before.body,
        bodyAfter: r.body,
        textBefore: snippet(before.body, edit),
        textAfter: snippet(r.body, edit),
        subjectMatches: r.subjectMatches,
        bodyMatches: r.bodyMatches,
      };
    });
    const changed = results.filter((r) => r.changed);

    const summary = {
      step,
      campaignName: String(raw.camp_name ?? raw.name ?? ""),
      total: results.length,
      changed: changed.length,
      droppedDeleted,
      results,
    };

    if (body.dryRun || changed.length === 0) {
      return NextResponse.json({ ...summary, dryRun: true, written: false, verified: true, unverified: [] });
    }

    // Step 1 of a parent must keep a subject on every variation. A
    // sub-sequence's step 1 replies in-thread and has none.
    if (step === 1 && !subsequence && results.some((r) => r.subjectAfter.trim() === "")) {
      return NextResponse.json(
        { error: "This would leave a step-1 variation with no subject line, which the API rejects." },
        { status: 400 }
      );
    }

    // --- Write every step back, target step edited --------------------------
    const byLabel = new Map(results.map((r) => [r.variation, r]));
    const writeSequences = sequences.map((s) =>
      s.step === step
        ? toWriteStep({
            ...s,
            variations: s.variations.map((v) => {
              const r = byLabel.get(v.variation);
              return r ? { ...v, subject: r.subjectAfter, body: r.bodyAfter } : v;
            }),
          })
        : toWriteStep(s)
    );
    const payload: Record<string, unknown> = { workspace_id, campaign_id, sequences: writeSequences };
    if (String(raw.campaign_type ?? "") === "subseq") {
      payload.first_wait_time = raw.first_wait_time ?? 0;
      if (raw.first_wait_time_unit) payload.first_wait_time_unit = raw.first_wait_time_unit;
    }

    await acquireSlot();
    await plusvibePatch<unknown>({ apiKey, path: "/campaign/update/campaign", body: payload });

    // --- Verify: the PATCH response doesn't echo sequences -------------------
    await acquireSlot();
    const after = await fetchCampaignRaw(apiKey, workspace_id, campaign_id);
    const afterStep = after ? normalizeSequences(after.sequences).find((s) => s.step === step) : undefined;
    const unverified: string[] = [];
    for (const r of changed) {
      const got = afterStep?.variations.find((v) => v.variation === r.variation);
      // Plusvibe may re-serialise markup on save, so compare as text.
      const ok =
        !!got &&
        (got.subject ?? "") === r.subjectAfter &&
        blockText(got.body ?? "") === blockText(r.bodyAfter);
      if (!ok) unverified.push(r.variation);
    }

    return NextResponse.json({
      ...summary,
      dryRun: false,
      written: true,
      verified: unverified.length === 0,
      unverified,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

function sanitizeEdit(e: unknown): CopyEdit | null {
  if (!e || typeof e !== "object") return null;
  const o = e as Record<string, unknown>;
  if (o.kind === "replace-text") {
    const target = o.target === "subject" || o.target === "body" ? o.target : "both";
    return {
      kind: "replace-text",
      find: String(o.find ?? ""),
      replace: String(o.replace ?? ""),
      target,
      caseSensitive: o.caseSensitive === true,
    };
  }
  if (o.kind === "set-section") {
    const section = o.section === "subject" || o.section === "opening" || o.section === "closing" ? o.section : null;
    if (!section) return null;
    return { kind: "set-section", section, text: String(o.text ?? ""), asHtml: o.asHtml === true };
  }
  return null;
}

/** The part of the body worth showing in the table for this edit. */
function snippet(html: string, edit: CopyEdit): string {
  if (edit.kind === "set-section" && edit.section !== "subject") {
    const text = blockText(html);
    const paras = text.split(/\n\s*\n/);
    return edit.section === "opening" ? paras[0] ?? "" : paras[paras.length - 1] ?? "";
  }
  return bodyPreview(html, 220);
}
