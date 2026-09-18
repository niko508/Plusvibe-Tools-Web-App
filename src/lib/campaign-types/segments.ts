// Sorting leads by their Segment field before the campaign types are built.
//
// Every lead carries a custom field called "segment" ("cash pay", "insurance",
// …). The run takes a handful of original campaigns and a table of rules —
// this segment goes to that campaign — and moves each lead into the campaign
// its segment names, so that by the time the Microsoft / Opt Out / Signature
// copies are made from a campaign, the campaign holds one segment's leads.
//
// One rule may be for the EMPTY segment: leads with no segment at all. A lead
// whose segment matches no rule stays where it is and is counted, never
// guessed at.
//
// Pure module — the moves themselves run in the job — so all of it is
// unit-tested.

/** A lead as the API returns it: whatever keys it has. */
type RawLead = Record<string, unknown>;

/** The lead field, as Plusvibe names it. Matched case-insensitively. */
export const SEGMENT_FIELD = "segment";

/** The most rules the form offers: three segments and the empty one. */
export const MAX_RULES = 4;

export interface SegmentRule {
  /** The segment's text, or null for leads whose segment is empty. */
  segment: string | null;
  campaignId: string;
  campaignName: string;
}

/** Comparison key for a segment: case and surrounding space don't matter. */
export function segmentKey(segment: string | null | undefined): string {
  return (segment ?? "").trim().toLowerCase();
}

/**
 * A lead's segment, trimmed; "" when it has none. The field may sit at the
 * top of the lead (how /lead/workspace-leads returns custom fields) or inside
 * custom_variables / payload, and its key may be capitalised.
 */
export function segmentOf(lead: RawLead): string {
  const holders: unknown[] = [lead, lead.custom_variables, lead.payload];
  for (const h of holders) {
    if (!h || typeof h !== "object") continue;
    for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
      if (k.trim().toLowerCase() !== SEGMENT_FIELD) continue;
      if (v === null || v === undefined) return "";
      return String(v).trim();
    }
  }
  return "";
}

/**
 * Problems with a set of rules, in reading order. Empty when they can run.
 *
 * `sourceIds` are the original campaigns picked: a rule can only send leads
 * to one of those, since those are the campaigns whose leads are read.
 */
export function validateRules(rules: SegmentRule[], sourceIds: string[]): string[] {
  const problems: string[] = [];
  const ids = new Set(sourceIds);
  const seen = new Set<string>();
  let empties = 0;
  rules.forEach((r, i) => {
    const row = i + 1;
    const label = r.segment === null ? "The empty-segment row" : `Row ${row}`;
    if (r.segment !== null && r.segment.trim() === "") {
      problems.push(`Row ${row}: give the segment a name, or leave the row out.`);
      return;
    }
    if (!r.campaignId) {
      problems.push(`${label}: pick the campaign its leads go to.`);
      return;
    }
    if (!ids.has(r.campaignId)) {
      problems.push(`${label}: "${r.campaignName || r.campaignId}" is not one of the original campaigns picked.`);
    }
    if (r.segment === null) {
      empties += 1;
      if (empties > 1) problems.push("Only one row can be for leads with no segment.");
      return;
    }
    const key = segmentKey(r.segment);
    if (seen.has(key)) problems.push(`Row ${row}: "${r.segment.trim()}" is already on another row.`);
    seen.add(key);
  });
  return problems;
}

/**
 * Cleans what the form sends: rows with nothing in them are dropped, the rest
 * are trimmed. Validation is separate so a half-filled row is reported, not
 * silently dropped.
 */
export function normalizeRules(raw: unknown): SegmentRule[] {
  if (!Array.isArray(raw)) return [];
  const out: SegmentRule[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const segment = o.segment === null ? null : String(o.segment ?? "").trim();
    const campaignId = String(o.campaignId ?? "").trim();
    const campaignName = String(o.campaignName ?? "").trim();
    // A row with neither a segment nor a campaign is an unused row.
    if (segment !== null && segment === "" && !campaignId) continue;
    out.push({ segment, campaignId, campaignName });
  }
  return out.slice(0, MAX_RULES);
}

export interface SegmentMove<T> {
  fromCampaignId: string;
  toCampaignId: string;
  toCampaignName: string;
  /** Null for the empty-segment rule. */
  segment: string | null;
  leads: T[];
}

export interface SegmentPlan<T> {
  moves: SegmentMove<T>[];
  counts: {
    total: number;
    /** Already in the campaign their segment names. */
    stayed: number;
    /** A segment no rule covers — left where they are. */
    unmapped: number;
    /** Distinct uncovered segments, a few of them, for the report. */
    unmappedSegments: string[];
    planned: number;
    /** Planned per rule, in rule order. */
    perRule: { segment: string | null; campaignId: string; planned: number }[];
  };
}

/**
 * Which leads move where. Leads are taken from every campaign given, in the
 * order given; a lead already sitting in its segment's campaign stays.
 */
export function planSegmentMoves<T extends RawLead>(
  campaigns: { campaignId: string; leads: T[] }[],
  rules: SegmentRule[]
): SegmentPlan<T> {
  const byKey = new Map<string, SegmentRule>();
  for (const r of rules) if (r.campaignId) byKey.set(r.segment === null ? "" : segmentKey(r.segment), r);

  const moves = new Map<string, SegmentMove<T>>();
  const perRule = new Map<SegmentRule, number>();
  const unmappedSegments = new Set<string>();
  let total = 0;
  let stayed = 0;
  let unmapped = 0;
  let planned = 0;

  for (const { campaignId, leads } of campaigns) {
    for (const lead of leads) {
      total += 1;
      const segment = segmentOf(lead);
      const rule = byKey.get(segmentKey(segment));
      if (!rule) {
        unmapped += 1;
        if (segment && unmappedSegments.size < 8) unmappedSegments.add(segment);
        continue;
      }
      if (rule.campaignId === campaignId) {
        stayed += 1;
        continue;
      }
      planned += 1;
      perRule.set(rule, (perRule.get(rule) ?? 0) + 1);
      const key = `${campaignId}→${rule.campaignId}`;
      let move = moves.get(key);
      if (!move) {
        move = { fromCampaignId: campaignId, toCampaignId: rule.campaignId, toCampaignName: rule.campaignName, segment: rule.segment, leads: [] };
        moves.set(key, move);
      }
      move.leads.push(lead);
    }
  }

  return {
    moves: [...moves.values()],
    counts: {
      total,
      stayed,
      unmapped,
      unmappedSegments: [...unmappedSegments],
      planned,
      perRule: rules.map((r) => ({ segment: r.segment, campaignId: r.campaignId, planned: perRule.get(r) ?? 0 })),
    },
  };
}

/** "cash pay → 🟡 Med Spa (August)", or "no segment → …". */
export function describeRule(r: { segment: string | null; campaignName: string }): string {
  return `${r.segment === null ? "no segment" : r.segment} → ${r.campaignName}`;
}
