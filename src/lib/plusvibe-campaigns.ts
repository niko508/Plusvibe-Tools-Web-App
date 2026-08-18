import "server-only";

import { plusvibeGet } from "@/lib/plusvibe-server";
import type {
  CampaignDetail,
  CampaignStepInfo,
  CampaignSummary,
  SequenceStep,
  SequenceVariation,
} from "@/lib/plusvibe-types";

// Helpers for the campaign/sequence endpoints.
//
// Sequences live on the campaign object: read with GET /campaign/list-all,
// written with PATCH /campaign/update/campaign. The `sequences` array replaces
// what's stored, so anything omitted is destroyed — every write here is a
// read-modify-write that carries the whole array back.

const PAGE_LIMIT = 100; // API max
const MAX_PAGES = 40; // safety cap: 4k campaigns
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export {
  VARIATION_LABELS,
  MAX_VARIATIONS_PER_STEP,
  nextVariationLabels,
} from "@/lib/variation-labels";

type RawCampaign = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Keeps warning text readable when dozens of stale labels come back.
function truncateList(items: string[], max = 12): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} … +${items.length - max} more`;
}

// The API returns a bare array; tolerate an envelope just in case.
function asArray(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    for (const key of ["campaigns", "data", "result"]) {
      const v = (data as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}

export function normalizeSequences(raw: unknown): SequenceStep[] {
  return asArray(raw)
    .map((s) => {
      const step = s as Record<string, unknown>;
      const variations = asArray(step.variations).map((v) => {
        const va = v as Record<string, unknown>;
        const out: SequenceVariation = {
          variation: str(va.variation),
          subject: str(va.subject),
          preheader: str(va.preheader),
          body: str(va.body),
        };
        if (va.name != null) out.name = str(va.name);
        return out;
      });
      return {
        step: num(step.step),
        wait_time: num(step.wait_time),
        variations,
      };
    })
    .filter((s) => s.step > 0)
    .sort((a, b) => a.step - b.step);
}

/** Lists every campaign in a workspace, paginating past the 100-per-page cap. */
export async function listCampaigns(
  apiKey: string,
  workspace_id: string
): Promise<CampaignSummary[]> {
  const out: CampaignSummary[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    if (page > 0) await sleep(220); // stay under the 5 req/s budget
    const data = await plusvibeGet<unknown>({
      apiKey,
      path: "/campaign/list-all",
      query: {
        workspace_id,
        campaign_type: "parent",
        skip: String(page * PAGE_LIMIT),
        limit: String(PAGE_LIMIT),
      },
    });
    const batch = asArray(data) as RawCampaign[];
    for (const c of batch) {
      const id = str(c.id ?? c._id);
      if (!id) continue;
      out.push({
        id,
        name: str(c.camp_name ?? c.name) || "(untitled)",
        status: str(c.status).toUpperCase(),
        campaignType: str(c.campaign_type) || undefined,
        sequenceSteps: num(c.sequence_steps, normalizeSequences(c.sequences).length),
      });
    }
    if (batch.length < PAGE_LIMIT) break;
  }
  return out;
}

/** Fetches one campaign's raw object (the only way to read its sequences). */
export async function fetchCampaignRaw(
  apiKey: string,
  workspace_id: string,
  campaign_id: string
): Promise<RawCampaign | null> {
  const data = await plusvibeGet<unknown>({
    apiKey,
    path: "/campaign/list-all",
    query: { workspace_id, campaign_id, limit: "1" },
  });
  const arr = asArray(data) as RawCampaign[];
  const match =
    arr.find((c) => str(c.id ?? c._id) === campaign_id) ?? arr[0] ?? null;
  return match ?? null;
}

export interface VariationFlags {
  isDel: boolean;
  isActive: boolean;
}

/** step -> variation label -> flags */
export type FlagMap = Map<number, Map<string, VariationFlags>>;

/**
 * Per-variation flags from variation-stats.
 *
 * This matters more than it looks: `sequences` keeps returning variations that
 * were DELETED in the Plusvibe UI (duplicating a campaign or removing steps
 * leaves them behind), and the sequences payload carries no is_del field to
 * tell them apart. Writing those back would resurrect them as live copy, so
 * they have to be identified here and dropped before any write.
 *
 * Best-effort: if stats are unavailable we return an empty map and keep
 * everything, since we can't prove anything is deleted.
 */
export async function fetchVariationFlags(
  apiKey: string,
  workspace_id: string,
  campaign_id: string
): Promise<FlagMap> {
  const byStep: FlagMap = new Map();
  try {
    const data = await plusvibeGet<unknown>({
      apiKey,
      path: "/campaign/get/variation-stats",
      query: { workspace_id, campaign_id },
    });
    for (const s of asArray(data)) {
      const step = s as Record<string, unknown>;
      const stepNo = num(step.step);
      if (!stepNo) continue;
      const labels = new Map<string, VariationFlags>();
      for (const v of asArray(step.variations)) {
        const va = v as Record<string, unknown>;
        const label = str(va.variation);
        if (!label) continue;
        labels.set(label, {
          isDel: va.is_del === true,
          isActive: va.is_active !== false,
        });
      }
      byStep.set(stepNo, labels);
    }
  } catch {
    // Stats unavailable — fall back to whatever `sequences` reports.
  }
  return byStep;
}

/**
 * Splits a step's variations into the ones that are really there and the ones
 * Plusvibe has deleted. Only variations stats EXPLICITLY marks is_del are
 * treated as deleted — a variation simply missing from stats (e.g. never sent)
 * is kept, since absence is not proof of deletion.
 */
export function splitDeleted(
  step: number,
  variations: SequenceVariation[],
  flags: FlagMap
): { live: SequenceVariation[]; deleted: SequenceVariation[] } {
  const forStep = flags.get(step);
  if (!forStep) return { live: variations, deleted: [] };
  const live: SequenceVariation[] = [];
  const deleted: SequenceVariation[] = [];
  for (const v of variations) {
    if (forStep.get(v.variation)?.isDel === true) deleted.push(v);
    else live.push(v);
  }
  return { live, deleted };
}

/** Builds the UI-facing campaign view, flagging variants we can't preserve. */
export function toCampaignDetail(
  raw: RawCampaign,
  flags: FlagMap
): CampaignDetail {
  const sequences = normalizeSequences(raw.sequences);
  const warnings: string[] = [];

  const steps: CampaignStepInfo[] = sequences.map((s) => {
    const { live, deleted } = splitDeleted(s.step, s.variations, flags);
    const forStep = flags.get(s.step);
    const present = new Set(s.variations.map((v) => v.variation));
    // Labels stats knows about that aren't in `sequences` at all, excluding
    // deleted ones (those are simply gone).
    const hidden = forStep
      ? Array.from(forStep.entries())
          .filter(([label, f]) => !f.isDel && !present.has(label))
          .map(([label]) => label)
      : [];
    const subject = live.find((v) => v.subject)?.subject ?? "";
    return {
      step: s.step,
      waitTime: s.wait_time ?? 0,
      variations: live,
      deletedVariations: deleted.map((v) => v.variation),
      hiddenVariations: hidden,
      subject,
    };
  });

  for (const s of steps) {
    if (s.deletedVariations.length > 0) {
      warnings.push(
        `Step ${s.step}: the API still returns ${s.deletedVariations.length} variation(s) that were deleted in Plusvibe (${truncateList(
          s.deletedVariations
        )}). They're excluded here and won't be written back, so they stay deleted.`
      );
    }
    if (s.hiddenVariations.length > 0) {
      warnings.push(
        `Step ${s.step}: ${s.hiddenVariations.length} variation(s) (${truncateList(
          s.hiddenVariations
        )}) exist on the campaign but aren't editable through the API — most likely disabled. Their letters won't be reused, but saving this step may drop them. Re-enable or remove them in Plusvibe first if you need them kept.`
      );
    }
  }

  if (steps.length === 0) {
    warnings.push(
      "This campaign has no sequence steps yet — add a step with your first variant in Plusvibe before using this tool."
    );
  }

  return {
    id: str(raw.id ?? raw._id),
    name: str(raw.camp_name ?? raw.name) || "(untitled)",
    status: str(raw.status).toUpperCase(),
    campaignType: str(raw.campaign_type) || undefined,
    steps,
    warnings,
  };
}

/**
 * Converts a normalized step to the write shape. `name` is required on write but
 * absent from reads, so preserved variants get "" unless they already carry one.
 */
export function toWriteStep(step: SequenceStep): Record<string, unknown> {
  return {
    step: step.step,
    wait_time: step.wait_time ?? 0,
    variations: step.variations.map((v) => ({
      variation: v.variation,
      subject: v.subject ?? "",
      preheader: v.preheader ?? "",
      name: v.name ?? "",
      body: v.body ?? "",
    })),
  };
}
