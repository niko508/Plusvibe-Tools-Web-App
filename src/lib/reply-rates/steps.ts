// Analyze Positive Reply Rates — Step 1 vs Step 2.
//
// Every campaign in the range counts. Its positive replies are split by the
// step Plusvibe puts them on: step 1 is the first email, step 2 the first
// follow-up. The count is the headline; beside it each step's rate is its
// positive replies per email that step sent, since fewer leads reach step 2.
//
// Pure module, read from the same figures as Opt Out vs No Opt Out.

import { gapBetween, type CampaignFigures, type Gap, type GroupTotals, type StepFigures } from "./opt-out";

export interface StepsComparison extends Gap {
  /** contacted here is emails the step sent; campaigns, the ones with that step. */
  step1: GroupTotals;
  step2: GroupTotals;
  /** Positive replies on step 3 and later, counted apart. */
  later: number;
  /** Step 1's share of the positive replies from steps 1 and 2, in %; null with none. */
  step1Share: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** A campaign's step in sequence order (0 = step 1); absent when it has no such step. */
export function stepAt(r: CampaignFigures, index: number): StepFigures | undefined {
  return r.steps?.[index];
}

function stepTotals(rows: CampaignFigures[], index: number): GroupTotals {
  const had = rows.map((r) => stepAt(r, index)).filter((s): s is StepFigures => s !== undefined);
  const contacted = had.reduce((n, s) => n + s.sent, 0);
  const positive = had.reduce((n, s) => n + s.positive, 0);
  return {
    campaigns: had.length,
    sending: had.filter((s) => s.sent > 0).length,
    contacted,
    positive,
    rate: contacted > 0 ? round2((positive / contacted) * 100) : null,
  };
}

export function compareSteps(rows: CampaignFigures[]): StepsComparison {
  const step1 = stepTotals(rows, 0);
  const step2 = stepTotals(rows, 1);
  const later = rows.reduce((n, r) => n + (r.steps ?? []).slice(2).reduce((m, s) => m + s.positive, 0), 0);
  const both = step1.positive + step2.positive;
  return {
    step1,
    step2,
    later,
    step1Share: both > 0 ? Math.round((step1.positive / both) * 1000) / 10 : null,
    ...gapBetween(step1, step2),
  };
}

/**
 * What one workspace says:
 *   step1 / step2   that step is clearly ahead per email sent (95% confidence)
 *   even            both sent and got replies, but no clear winner
 *   too-few         too few positive replies to say
 *   one-step        only one of the two steps sent anything
 *   none            nothing was sent
 */
export type StepsVerdict = "step1" | "step2" | "even" | "too-few" | "one-step" | "none";

export interface WorkspaceSteps extends StepsComparison {
  workspaceId: string;
  workspaceName: string;
  verdict: StepsVerdict;
}

export function stepsVerdictOf(c: StepsComparison): StepsVerdict {
  if (c.step1.contacted === 0 && c.step2.contacted === 0) return "none";
  if (c.difference === null) return "one-step";
  if (c.confidence === "too-few") return "too-few";
  if (c.confidence === "likely") return c.difference > 0 ? "step1" : "step2";
  return "even";
}

const ORDER: StepsVerdict[] = ["step2", "step1", "even", "too-few", "one-step", "none"];

/**
 * Every workspace's own Step 1 vs Step 2. Where step 2 is clearly ahead comes
 * first — the unusual case worth a look — then step 1, the most positive
 * replies at the top of each kind.
 */
export function compareStepsByWorkspace(rows: CampaignFigures[]): WorkspaceSteps[] {
  const byWs = new Map<string, CampaignFigures[]>();
  for (const r of rows) {
    const list = byWs.get(r.workspaceId) ?? [];
    list.push(r);
    byWs.set(r.workspaceId, list);
  }
  return [...byWs.values()]
    .map((list) => {
      const c = compareSteps(list);
      return { ...c, workspaceId: list[0].workspaceId, workspaceName: list[0].workspaceName, verdict: stepsVerdictOf(c) };
    })
    .sort(
      (a, b) =>
        ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict) ||
        b.step1.positive + b.step2.positive - (a.step1.positive + a.step2.positive) ||
        a.workspaceName.localeCompare(b.workspaceName)
    );
}
