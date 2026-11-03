import "server-only";

import { plusvibePatch } from "@/lib/plusvibe-server";
import { acquireSlot } from "@/lib/jobs/rate-limit";
import {
  fetchCampaignRaw,
  fetchVariationFlags,
  normalizeSequences,
  splitDeleted,
  toWriteStep,
  bodyPreview,
} from "@/lib/plusvibe-campaigns";
import { applyEdit, blockText, validateEdit, type CopyEdit } from "./edit";

// One campaign, one edit, one read-modify-write.
//
// Shared by the single-campaign tool and the bulk job so the two can never
// drift: the same reading, the same dropping of deleted variations, the same
// write of every step, the same read-back check.
//
// PATCH /campaign/update/campaign REPLACES the whole `sequences` array, so
// this always re-reads the campaign first, edits only the target step(s),
// writes EVERY step back untouched, then re-reads to confirm.

export interface VariationResult {
  variation: string;
  changed: boolean;
  reason?: string;
  subjectBefore: string;
  subjectAfter: string;
  bodyBefore: string;
  bodyAfter: string;
  /** Plain-text snippets for a table. */
  textBefore: string;
  textAfter: string;
  subjectMatches: number;
  bodyMatches: number;
}

export interface StepResult {
  step: number;
  total: number;
  changed: number;
  results: VariationResult[];
}

export interface CampaignEditOutcome {
  campaignId: string;
  campaignName: string;
  campaignType: string;
  steps: StepResult[];
  /** Live variations across the edited steps, for a stale-preview guard. */
  liveVariations: number;
  droppedDeleted: number;
  changed: number;
  dryRun: boolean;
  written: boolean;
  verified: boolean;
  unverified: { step: number; variation: string }[];
}

export class CampaignEditError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409
  ) {
    super(message);
    this.name = "CampaignEditError";
  }
}

/**
 * Applies `edit` to one campaign.
 *
 * `step` narrows it to one step; omitted means every step. `dryRun` reports
 * without writing. `expectedVariationCount` refuses to write when the live
 * count differs from what a preview was built from.
 */
export async function editCampaignCopy(params: {
  apiKey: string;
  workspaceId: string;
  campaignId: string;
  edit: CopyEdit;
  step?: number;
  dryRun?: boolean;
  expectedVariationCount?: number;
  /** Keep full before/after HTML on each variation (the single tool's table). */
  includeBodies?: boolean;
}): Promise<CampaignEditOutcome> {
  const { apiKey, workspaceId, campaignId, edit, step } = params;

  await acquireSlot();
  const raw = await fetchCampaignRaw(apiKey, workspaceId, campaignId);
  if (!raw) throw new CampaignEditError("Campaign not found", 404);
  const campaignType = String(raw.campaign_type ?? "") || "parent";
  const subsequence = campaignType === "subseq";
  const campaignName = String(raw.camp_name ?? raw.name ?? "");

  const rawSequences = normalizeSequences(raw.sequences);
  await acquireSlot();
  const flags = await fetchVariationFlags(apiKey, workspaceId, campaignId);
  let droppedDeleted = 0;
  const sequences = rawSequences.map((s) => {
    const { live, deleted } = splitDeleted(s.step, s.variations, flags);
    droppedDeleted += deleted.length;
    return { ...s, variations: live };
  });

  const targets = step === undefined ? sequences : sequences.filter((s) => s.step === step);
  if (step !== undefined && targets.length === 0) {
    throw new CampaignEditError(`Step ${step} not found on this campaign.`, 400);
  }
  for (const t of targets) {
    const problems = validateEdit(edit, t.step, { subsequence });
    if (problems.length > 0) throw new CampaignEditError(problems.join(" "), 400);
  }

  const liveVariations = targets.reduce((n, s) => n + s.variations.length, 0);
  if (
    typeof params.expectedVariationCount === "number" &&
    params.expectedVariationCount !== liveVariations
  ) {
    throw new CampaignEditError(
      `The campaign now has ${liveVariations} variations on the edited step(s) but the preview was built from ${params.expectedVariationCount}. Preview again before applying.`,
      409
    );
  }

  const steps: StepResult[] = targets.map((s) => {
    const results = s.variations.map((v): VariationResult => {
      const before = { variation: v.variation, subject: v.subject ?? "", body: v.body ?? "" };
      const r = applyEdit(before, edit);
      return {
        variation: v.variation,
        changed: r.changed,
        reason: r.reason,
        subjectBefore: before.subject,
        subjectAfter: r.subject,
        bodyBefore: params.includeBodies ? before.body : "",
        bodyAfter: params.includeBodies || r.changed ? r.body : "",
        textBefore: snippet(before.body, edit),
        textAfter: snippet(r.body, edit),
        subjectMatches: r.subjectMatches,
        bodyMatches: r.bodyMatches,
      };
    });
    return { step: s.step, total: results.length, changed: results.filter((r) => r.changed).length, results };
  });
  const changed = steps.reduce((n, s) => n + s.changed, 0);

  const base = {
    campaignId,
    campaignName,
    campaignType,
    steps,
    liveVariations,
    droppedDeleted,
    changed,
  };

  if (params.dryRun || changed === 0) {
    return { ...base, dryRun: true, written: false, verified: true, unverified: [] };
  }

  // Step 1 of a parent must keep a subject on every variation.
  if (!subsequence) {
    const one = steps.find((s) => s.step === 1);
    if (one && one.results.some((r) => r.subjectAfter.trim() === "")) {
      throw new CampaignEditError(
        "This would leave a step-1 variation with no subject line, which the API rejects.",
        400
      );
    }
  }

  // --- Write every step back, edited steps updated ---------------------------
  const byStep = new Map(steps.map((s) => [s.step, new Map(s.results.map((r) => [r.variation, r]))]));
  const writeSequences = sequences.map((s) => {
    const edited = byStep.get(s.step);
    if (!edited) return toWriteStep(s);
    return toWriteStep({
      ...s,
      variations: s.variations.map((v) => {
        const r = edited.get(v.variation);
        return r && r.changed ? { ...v, subject: r.subjectAfter, body: r.bodyAfter } : v;
      }),
    });
  });
  const payload: Record<string, unknown> = { workspace_id: workspaceId, campaign_id: campaignId, sequences: writeSequences };
  if (subsequence) {
    payload.first_wait_time = raw.first_wait_time ?? 0;
    if (raw.first_wait_time_unit) payload.first_wait_time_unit = raw.first_wait_time_unit;
  }

  await acquireSlot();
  await plusvibePatch<unknown>({ apiKey, path: "/campaign/update/campaign", body: payload });

  // --- Verify: the PATCH response doesn't echo sequences ----------------------
  await acquireSlot();
  const after = await fetchCampaignRaw(apiKey, workspaceId, campaignId);
  const afterSteps = after ? normalizeSequences(after.sequences) : [];
  const unverified: { step: number; variation: string }[] = [];
  for (const s of steps) {
    const got = afterSteps.find((x) => x.step === s.step);
    for (const r of s.results) {
      if (!r.changed) continue;
      const v = got?.variations.find((x) => x.variation === r.variation);
      // Plusvibe may re-serialise markup on save, so compare as text.
      const ok = !!v && (v.subject ?? "") === r.subjectAfter && blockText(v.body ?? "") === blockText(r.bodyAfter);
      if (!ok) unverified.push({ step: s.step, variation: r.variation });
    }
  }

  return { ...base, dryRun: false, written: true, verified: unverified.length === 0, unverified };
}

/** The part of the body worth showing in a table for this edit. */
function snippet(html: string, edit: CopyEdit): string {
  if (edit.kind === "set-section" && edit.section !== "subject") {
    const text = blockText(html);
    const paras = text.split(/\n\s*\n/);
    return edit.section === "opening" ? paras[0] ?? "" : paras[paras.length - 1] ?? "";
  }
  return bodyPreview(html, 220);
}

export function sanitizeEdit(e: unknown): CopyEdit | null {
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
