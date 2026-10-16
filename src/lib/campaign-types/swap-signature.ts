import type { SequenceStep } from "@/lib/plusvibe-types";

// Swaps the sign-off variable in STEP 1 of the parent sequence — and nowhere
// else. Not later steps, not sub-sequences.
//
//   {{sender_first_name}}  ->  {{sender_signature}}
//
// The variable is replaced wherever it appears in a step-1 variation, subject
// included, because a subject signed with the first name while the body signs
// with the full signature would read as two different senders.
//
// Whitespace inside the braces is tolerated on the way in. Plusvibe's editor
// normally emits "{{sender_first_name}}", but a variable typed by hand can
// carry padding, and missing those would silently leave the campaign as an
// ordinary copy of the source.

export const SENDER_FIRST_NAME = "{{sender_first_name}}";
export const SENDER_SIGNATURE = "{{sender_signature}}";

const FIRST_NAME_RE = /\{\{\s*sender_first_name\s*\}\}/g;
const SIGNATURE_RE = /\{\{\s*sender_signature\s*\}\}/;

export function hasSenderFirstName(text: string): boolean {
  // Fresh regex each call: FIRST_NAME_RE is global and carries lastIndex.
  return /\{\{\s*sender_first_name\s*\}\}/.test(text);
}

export function hasSenderSignature(text: string): boolean {
  return SIGNATURE_RE.test(text);
}

export function swapInText(text: string): string {
  return text.replace(FIRST_NAME_RE, SENDER_SIGNATURE);
}

export interface SwapResult {
  steps: SequenceStep[];
  /** Variation labels whose sign-off was swapped, e.g. ["A", "B"]. */
  changed: string[];
  /** Labels already signing off with the signature, left untouched. */
  alreadyPresent: string[];
  /**
   * Labels carrying neither variable, so there was nothing to swap.
   *
   * Reported rather than ignored: a variation that signs off some other way is
   * a copy the sender never sees the signature on, and the person running this
   * should know before the campaign launches.
   */
  missing: string[];
}

/**
 * Returns a new sequence array with step 1's variations signing off with the
 * signature variable.
 *
 * The whole array is returned because PATCH /campaign/update/campaign REPLACES
 * `sequences` wholesale — every step must be written back, not just the edited
 * one, or the rest of the campaign is destroyed.
 */
export function swapSignatureInStepOne(steps: SequenceStep[]): SwapResult {
  const changed: string[] = [];
  const alreadyPresent: string[] = [];
  const missing: string[] = [];

  const out = steps.map((s) => {
    if (s.step !== 1) return s;
    return {
      ...s,
      variations: s.variations.map((v) => {
        const body = v.body ?? "";
        const subject = v.subject ?? "";
        if (!hasSenderFirstName(body) && !hasSenderFirstName(subject)) {
          // Already swapped on an earlier run, or never had the variable.
          if (hasSenderSignature(body) || hasSenderSignature(subject)) {
            alreadyPresent.push(v.variation);
          } else {
            missing.push(v.variation);
          }
          return v;
        }
        changed.push(v.variation);
        return {
          ...v,
          ...(v.body !== undefined ? { body: swapInText(v.body) } : {}),
          ...(v.subject !== undefined ? { subject: swapInText(v.subject) } : {}),
        };
      }),
    };
  });

  return { steps: out, changed, alreadyPresent, missing };
}
