// Matching the blueprint's lead labels against a workspace's real ones.
//
// A sub-sequence trigger needs each label's stable `key`, and the key is NOT
// safely derivable from the display name: the names carry emoji, and the
// documented rule ("letters/numbers kept, everything else becomes `_`,
// uppercased") turns a multi-code-unit emoji into an unpredictable run of
// underscores. So the key is always read back from the API — either from the
// existing label, or from the create response.
//
// Pure module: no API calls, so the matching rules are unit-testable.

import type { SpecLabel } from "@/lib/first-campaign/blueprint";

/** One label as the workspace reports it. */
export interface WorkspaceLabel {
  key: string;
  name: string;
  isSystem?: boolean;
}

/**
 * Comparable form of a label name.
 *
 * Emoji, punctuation and case are all cosmetic here — "🤩 positive reply 1",
 * "Positive Reply 1" and "positive-reply-1" are the same label to a human, and
 * a workspace set up by hand will have drifted in exactly those ways. Anything
 * that isn't a letter or a digit becomes a single space.
 *
 * The words themselves are kept intact, so the distinct labels in the blueprint
 * ("meeting booked" vs "meeting booked - cell phone call") never collapse into
 * each other.
 */
export function normalizeLabelName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export interface LabelResolution {
  /** The blueprint's label. */
  spec: SpecLabel;
  /** Matched existing label, if the workspace already had one. */
  existing?: WorkspaceLabel;
}

export interface LabelPlan {
  /** Labels already in the workspace — their keys are used as-is. */
  matched: LabelResolution[];
  /** Labels that must be created before the sub-sequences can be built. */
  missing: SpecLabel[];
}

/**
 * Works out which of the blueprint's labels the workspace already has.
 *
 * A brand-new workspace typically has none of them, which is the whole reason
 * this tool exists — but a workspace set up partway by hand will have some, and
 * re-creating those would fail (the API rejects a duplicate name) or, worse,
 * leave two near-identical labels behind.
 */
export function planLabels(
  spec: SpecLabel[],
  workspaceLabels: WorkspaceLabel[]
): LabelPlan {
  // System labels are never candidates. Plusvibe ships a built-in "Meeting
  // Booked", and the blueprint wants the workspace's own "🤑 meeting booked" —
  // which normalize identically once the emoji and case are stripped. Matching
  // the system one wires the sub-sequence to a label nobody applies, and the
  // trigger then simply never fires. Every label in the blueprint is a custom
  // one by definition, so excluding system labels is both safe and correct.
  const custom = workspaceLabels.filter((l) => !l.isSystem && l.key);

  const byExact = new Map<string, WorkspaceLabel>();
  const byNormalized = new Map<string, WorkspaceLabel>();
  for (const label of custom) {
    const exact = label.name.trim().toLowerCase();
    if (exact && !byExact.has(exact)) byExact.set(exact, label);
    const norm = normalizeLabelName(label.name);
    // First one wins, so a later near-duplicate can't shadow the real label.
    if (norm && !byNormalized.has(norm)) byNormalized.set(norm, label);
  }

  const matched: LabelResolution[] = [];
  const missing: SpecLabel[] = [];
  for (const s of spec) {
    // An exact name match wins over a normalized one, so a workspace holding
    // both "🤑 meeting booked" and some other label that merely normalizes the
    // same way still resolves to the one actually asked for.
    const existing =
      byExact.get(s.name.trim().toLowerCase()) ??
      byNormalized.get(normalizeLabelName(s.name));
    if (existing) matched.push({ spec: s, existing });
    else missing.push(s);
  }
  return { matched, missing };
}

/**
 * Looks up the keys for one sub-sequence's labels.
 *
 * Throws rather than dropping a label: a sub-sequence triggered by one of two
 * intended labels would silently miss half the leads it should catch, and that
 * is invisible until someone notices the follow-ups never went out.
 */
export function keysForLabels(
  labels: SpecLabel[],
  keyByName: Map<string, string>
): string[] {
  const keys: string[] = [];
  for (const label of labels) {
    const key = keyByName.get(normalizeLabelName(label.name));
    if (!key) {
      throw new Error(`No lead label key resolved for "${label.name}"`);
    }
    keys.push(key);
  }
  return keys;
}

/** Index resolved labels by normalized name, for keysForLabels. */
export function buildKeyIndex(
  entries: Array<{ name: string; key: string }>
): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of entries) {
    const norm = normalizeLabelName(e.name);
    if (norm && e.key && !map.has(norm)) map.set(norm, e.key);
  }
  return map;
}
