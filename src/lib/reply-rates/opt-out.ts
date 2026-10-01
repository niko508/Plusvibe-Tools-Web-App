// Analyze Positive Reply Rates — Opt Out vs No Opt Out.
//
// Every campaign in the range counts, in one of two groups, by its name:
//
//   Opt Out      the name carries "Opt Out" (🟡 or 🔵 alike)
//   No Opt Out   every other campaign — plain, 🔵, Signature
//
// One number per group: the positive reply rate, positive replies per lead
// emailed. Leads emailed is what step 1 sent in the range (each lead gets step
// 1 once); positive replies are counted over every step, since a lead the
// first email won over may answer a follow-up.
//
// Pure module: no API, so all of it is unit-tested.

import { hasOptOut } from "@/lib/campaign-types/names";
import type { StatsByStep } from "@/lib/winning-variants/plan";

export type OptOutGroup = "optOut" | "noOptOut";

export interface CampaignFigures {
  workspaceId: string;
  workspaceName: string;
  campaignId: string;
  name: string;
  /** Step-1 emails sent in the range: the leads emailed. */
  contacted: number;
  /** Positive replies in the range, every step. */
  positive: number;
}

export function groupOf(name: string): OptOutGroup {
  return hasOptOut(name) ? "optOut" : "noOptOut";
}

/** A campaign's figures from its variation stats: the first step's sends, every step's positive replies. */
export function figuresFrom(stats: StatsByStep): { contacted: number; positive: number } {
  const steps = [...stats.keys()].sort((a, b) => a - b);
  let contacted = 0;
  let positive = 0;
  steps.forEach((step, i) => {
    for (const v of stats.get(step)!.values()) {
      if (i === 0) contacted += v.sent;
      positive += v.positiveReplies;
    }
  });
  return { contacted, positive };
}

export interface GroupTotals {
  campaigns: number;
  /** Of them, the ones that sent anything in the range. */
  sending: number;
  contacted: number;
  positive: number;
  /** Positive replies per 100 leads emailed, 2 decimals; null with no leads emailed. */
  rate: number | null;
}

export interface OptOutComparison {
  optOut: GroupTotals;
  noOptOut: GroupTotals;
  /** Opt Out's rate minus No Opt Out's, in points; null unless both have a rate. */
  difference: number | null;
  /** The same as a share of No Opt Out's rate: +25 means a quarter higher. */
  relative: number | null;
  /**
   * Whether a gap this size could be chance, by a two-proportion test:
   * "likely" at 95% confidence, "unclear" below it, "too-few" when either
   * group has too few positive replies to say anything.
   */
  confidence: "likely" | "unclear" | "too-few" | null;
}

/** Below this many positive replies in a group, any gap is noise. */
export const MIN_POSITIVE = 5;

const round2 = (n: number) => Math.round(n * 100) / 100;

function totals(rows: CampaignFigures[]): GroupTotals {
  const contacted = rows.reduce((n, r) => n + r.contacted, 0);
  const positive = rows.reduce((n, r) => n + r.positive, 0);
  return {
    campaigns: rows.length,
    sending: rows.filter((r) => r.contacted > 0).length,
    contacted,
    positive,
    rate: contacted > 0 ? round2((positive / contacted) * 100) : null,
  };
}

export function compareOptOut(rows: CampaignFigures[]): OptOutComparison {
  const optOut = totals(rows.filter((r) => groupOf(r.name) === "optOut"));
  const noOptOut = totals(rows.filter((r) => groupOf(r.name) === "noOptOut"));
  if (optOut.rate === null || noOptOut.rate === null) return { optOut, noOptOut, difference: null, relative: null, confidence: null };
  const difference = round2(optOut.rate - noOptOut.rate);
  const relative = noOptOut.rate > 0 ? Math.round((difference / noOptOut.rate) * 1000) / 10 : null;
  let confidence: OptOutComparison["confidence"];
  if (optOut.positive < MIN_POSITIVE || noOptOut.positive < MIN_POSITIVE) confidence = "too-few";
  else {
    const p1 = optOut.positive / optOut.contacted;
    const p2 = noOptOut.positive / noOptOut.contacted;
    const p = (optOut.positive + noOptOut.positive) / (optOut.contacted + noOptOut.contacted);
    const se = Math.sqrt(p * (1 - p) * (1 / optOut.contacted + 1 / noOptOut.contacted));
    confidence = se > 0 && Math.abs(p1 - p2) / se >= 1.96 ? "likely" : "unclear";
  }
  return { optOut, noOptOut, difference, relative, confidence };
}

/** A range of whole days, oldest first, "YYYY-MM-DD"; null with the problem when it doesn't read. */
export function checkRange(start: string, end: string, today: string): { start: string; end: string } | { problem: string } {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(start) || !re.test(end)) return { problem: "Pick both dates." };
  if (start > end) return { problem: "The start date is after the end date." };
  if (end > today) return { problem: "The end date is in the future." };
  return { start, end };
}

// --- Workspace by workspace -----------------------------------------------------

/**
 * What one workspace says:
 *   optOut / noOptOut   that group is clearly ahead — the gap per lead holds
 *                       at 95% confidence
 *   even                both sent and got replies, but no clear winner
 *   too-few             too few positive replies to say
 *   one-group           only one group sent anything
 *   none                nothing was sent
 */
export type WorkspaceVerdict = "optOut" | "noOptOut" | "even" | "too-few" | "one-group" | "none";

export interface WorkspaceComparison extends OptOutComparison {
  workspaceId: string;
  workspaceName: string;
  verdict: WorkspaceVerdict;
}

export function verdictOf(c: OptOutComparison): WorkspaceVerdict {
  if (c.optOut.contacted === 0 && c.noOptOut.contacted === 0) return "none";
  if (c.difference === null) return "one-group";
  if (c.confidence === "too-few") return "too-few";
  if (c.confidence === "likely") return c.difference > 0 ? "optOut" : "noOptOut";
  return "even";
}

const VERDICT_ORDER: WorkspaceVerdict[] = ["optOut", "noOptOut", "even", "too-few", "one-group", "none"];

/**
 * Every workspace's own comparison: clear winners first, the biggest gaps in
 * positive replies at the top of each kind.
 */
export function compareByWorkspace(rows: CampaignFigures[]): WorkspaceComparison[] {
  const byWs = new Map<string, CampaignFigures[]>();
  for (const r of rows) {
    const list = byWs.get(r.workspaceId) ?? [];
    list.push(r);
    byWs.set(r.workspaceId, list);
  }
  return [...byWs.values()]
    .map((list) => {
      const c = compareOptOut(list);
      return { ...c, workspaceId: list[0].workspaceId, workspaceName: list[0].workspaceName, verdict: verdictOf(c) };
    })
    .sort(
      (a, b) =>
        VERDICT_ORDER.indexOf(a.verdict) - VERDICT_ORDER.indexOf(b.verdict) ||
        Math.abs(b.optOut.positive - b.noOptOut.positive) - Math.abs(a.optOut.positive - a.noOptOut.positive) ||
        a.workspaceName.localeCompare(b.workspaceName)
    );
}
