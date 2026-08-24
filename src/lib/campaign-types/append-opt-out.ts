import type { SequenceStep } from "@/lib/plusvibe-types";
import { OPT_OUT_SPINTAX } from "./opt-out-spintax";

// Appends the opt-out spintax to the bottom of every variation in STEP 1 of the
// parent sequence — and nowhere else. Not later steps, not sub-sequences.
//
// Plusvibe's editor gives <p> no margin, so paragraphs are <div>s separated by
// a non-breaking-space spacer div. That's the same shape the Copy Variations
// tool emits, which is what renders correctly in the campaign editor.

const SPACER = "<div>&nbsp;</div>";

/** Wraps the block the way Plusvibe's editor expects a trailing paragraph. */
export function optOutHtml(): string {
  return `${SPACER}<div>${OPT_OUT_SPINTAX}</div>`;
}

/**
 * True if a body already ends with the opt-out block. Makes the whole operation
 * idempotent: re-running a job (or resuming an interrupted one) must not stack
 * a second copy onto the same variation.
 *
 * Matched on the spintax text itself rather than the wrapper, because the
 * editor may re-serialise the surrounding markup between runs.
 */
export function hasOptOutBlock(body: string): boolean {
  return body.includes(OPT_OUT_SPINTAX);
}

export function appendOptOutToBody(body: string): string {
  if (hasOptOutBlock(body)) return body;
  return `${body}${optOutHtml()}`;
}

export interface AppendResult {
  steps: SequenceStep[];
  /** Variation labels that got the block, e.g. ["A", "B"]. */
  changed: string[];
  /** Labels already carrying it, left untouched. */
  alreadyPresent: string[];
}

/**
 * Returns a new sequence array with step 1's variations carrying the block.
 *
 * The whole array is returned because PATCH /campaign/update/campaign REPLACES
 * `sequences` wholesale — every step must be written back, not just the edited
 * one, or the rest of the campaign is destroyed.
 */
export function appendOptOutToStepOne(steps: SequenceStep[]): AppendResult {
  const changed: string[] = [];
  const alreadyPresent: string[] = [];

  const out = steps.map((s) => {
    if (s.step !== 1) return s;
    return {
      ...s,
      variations: s.variations.map((v) => {
        const body = v.body ?? "";
        if (hasOptOutBlock(body)) {
          alreadyPresent.push(v.variation);
          return v;
        }
        changed.push(v.variation);
        return { ...v, body: appendOptOutToBody(body) };
      }),
    };
  });

  return { steps: out, changed, alreadyPresent };
}
