// Copy Campaign to Other Workspace: what the run will do, and whether the
// choices make sense before anything is created.
//
// The shape of the job:
//
//   1. The DESTINATION campaign is duplicated inside its own workspace. That
//      copy carries the destination's settings, schedule, sender accounts and
//      sub-sequences — none of which can cross a workspace boundary, which is
//      exactly why the copy is made there rather than moved.
//   2. The SOURCE campaign's email copy is then written over the new
//      campaign's parent sequences. The sub-sequences keep the destination's
//      content.
//
// Pure module — no API, no clock — so all of it is unit-tested.

export interface CopySelection {
  sourceWorkspaceId: string;
  sourceCampaignId: string;
  destWorkspaceId: string;
  destCampaignId: string;
  /** What the new campaign is called. */
  name: string;
}

export const MAX_NAME = 200;

/** The name a copy gets unless the user changes it: the source's own. */
export function defaultName(sourceName: string): string {
  return (sourceName ?? "").trim().slice(0, MAX_NAME);
}

/**
 * Everything wrong with the selection, in the order it should be fixed.
 * `sourceSteps` is the number of live steps read from the source; pass it once
 * the source has been loaded so an empty campaign is caught before the copy is
 * created rather than after.
 */
export function planProblems(
  sel: Partial<CopySelection>,
  opts: { sourceSteps?: number } = {}
): string[] {
  const problems: string[] = [];
  if (!sel.sourceWorkspaceId) problems.push("Pick the source workspace.");
  if (!sel.sourceCampaignId) problems.push("Pick the campaign to copy from.");
  if (!sel.destWorkspaceId) problems.push("Pick the destination workspace.");
  if (!sel.destCampaignId) {
    problems.push("Pick the destination campaign to take the settings from.");
  }
  const name = (sel.name ?? "").trim();
  if (!name) problems.push("Give the new campaign a name.");
  else if (name.length > MAX_NAME) {
    problems.push(`The name is too long (max ${MAX_NAME} characters).`);
  }
  if (opts.sourceSteps === 0) {
    problems.push("The source campaign has no sequence steps to copy.");
  }
  return problems;
}

/**
 * Things worth saying that are not mistakes. Copying a campaign onto a
 * duplicate of itself is legal and occasionally deliberate, so it warns
 * rather than blocks.
 */
export function planWarnings(sel: Partial<CopySelection>): string[] {
  const warnings: string[] = [];
  if (
    sel.sourceCampaignId &&
    sel.sourceCampaignId === sel.destCampaignId &&
    sel.sourceWorkspaceId === sel.destWorkspaceId
  ) {
    warnings.push(
      "The source and the destination are the same campaign, so this just clones it with its own copy."
    );
  }
  if (
    sel.sourceWorkspaceId &&
    sel.sourceWorkspaceId === sel.destWorkspaceId
  ) {
    warnings.push(
      "Both workspaces are the same, so the copy is created alongside the original."
    );
  }
  return warnings;
}

/** One step reduced to what a copy has to reproduce. */
export interface StepShape {
  step: number;
  variations: number;
}

export function shapeOf(
  steps: { step: number; variations: unknown[] }[]
): StepShape[] {
  return steps
    .map((s) => ({ step: s.step, variations: s.variations.length }))
    .sort((a, b) => a.step - b.step);
}

export function countVariations(shape: StepShape[]): number {
  return shape.reduce((n, s) => n + s.variations, 0);
}

export interface ShapeCheck {
  ok: boolean;
  problems: string[];
}

/**
 * Compares what was sent against what the campaign reads back as. Plusvibe's
 * update call does not echo the sequences, so the copy is only proven by
 * re-reading it.
 */
export function compareShapes(
  expected: StepShape[],
  actual: StepShape[]
): ShapeCheck {
  const problems: string[] = [];
  if (expected.length !== actual.length) {
    problems.push(
      `Expected ${expected.length} step${expected.length === 1 ? "" : "s"} on the copy but found ${actual.length}.`
    );
  }
  const actualByStep = new Map(actual.map((s) => [s.step, s.variations]));
  for (const e of expected) {
    const got = actualByStep.get(e.step);
    if (got === undefined) {
      problems.push(`Step ${e.step} is missing from the copy.`);
    } else if (got !== e.variations) {
      problems.push(
        `Step ${e.step} should have ${e.variations} variation${e.variations === 1 ? "" : "s"} but has ${got}.`
      );
    }
  }
  return { ok: problems.length === 0, problems };
}

/** A sentence describing what the run will do, for the confirm step. */
export function describePlan(params: {
  sourceCampaign: string;
  destCampaign: string;
  destWorkspace: string;
  name: string;
  steps: number;
  variations: number;
  subsequences: boolean;
}): string {
  const copy = `${params.steps} step${params.steps === 1 ? "" : "s"} and ${params.variations} variation${params.variations === 1 ? "" : "s"}`;
  return (
    `"${params.destCampaign}" will be duplicated inside ${params.destWorkspace} as "${params.name}", ` +
    `carrying its settings, schedule, sender accounts${params.subsequences ? " and sub-sequences" : ""}. ` +
    `The new campaign's own copy is then replaced with ${copy} from "${params.sourceCampaign}".`
  );
}
