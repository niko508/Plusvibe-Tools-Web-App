// Creating one custom lead label across many workspaces.
//
// Pure module: the rules Plusvibe enforces on a label name, plus the decision
// of what to do with each workspace, with no API calls — so both are
// unit-testable and the route stays thin.
//
// Emoji are the point of this action, not an edge case: every label here is
// named like "🤑 meeting booked". The API's `icon` field only accepts
// letters/numbers/spaces/dashes, so the emoji has to live in `name` — which it
// happily does, and which is why nothing below strips or rejects it.

import {
  normalizeLabelName,
  type WorkspaceLabel,
} from "@/lib/lead-labels/normalize";

export type Sentiment = "POSITIVE" | "NEGATIVE" | "NEUTRAL";

export const SENTIMENTS: { value: Sentiment; label: string }[] = [
  { value: "POSITIVE", label: "Positive" },
  { value: "NEGATIVE", label: "Negative" },
  { value: "NEUTRAL", label: "Neutral" },
];

export function isSentiment(v: unknown): v is Sentiment {
  return v === "POSITIVE" || v === "NEGATIVE" || v === "NEUTRAL";
}

/**
 * Plusvibe's cap, counted the way the API counts it.
 *
 * The limit is on the string's length, and in UTF-16 most emoji are two units
 * (some, like 🧑‍💼, are far more). So `nameLength` is deliberately `.length`
 * and not a grapheme count — a name that looks like 40 characters can be over
 * the limit, and it's better to say so here than to have the API say it once
 * per workspace.
 */
export const MAX_LABEL_NAME_LENGTH = 100;

export function nameLength(name: string): number {
  return name.trim().length;
}

/**
 * Everything wrong with a label name, in the order worth reading.
 *
 * Returns an empty array when the name is fine.
 */
export function validateLabelName(name: string): string[] {
  const problems: string[] = [];
  const trimmed = name.trim();

  if (trimmed === "") {
    return ["Give the label a name."];
  }
  if (trimmed.includes("<") || trimmed.includes(">")) {
    problems.push("The name can't contain < or >.");
  }
  if (trimmed.length > MAX_LABEL_NAME_LENGTH) {
    problems.push(
      `The name is ${trimmed.length} characters; the limit is ${MAX_LABEL_NAME_LENGTH}. Emoji count as two or more.`
    );
  }
  // Nothing left to compare on once the emoji and punctuation are stripped —
  // "🤑" alone would be created, but nothing could ever match it afterwards,
  // including a second run of this action.
  if (normalizeLabelName(trimmed) === "") {
    problems.push(
      "The name needs at least one letter or number, not only emoji or punctuation."
    );
  }
  return problems;
}

export type LabelOutcome = "created" | "already" | "conflict" | "error";

/** How an existing label was recognised — an exact name, or a near-match. */
export type MatchKind = "exact" | "similar";

export interface Classification {
  /** "create" means nothing in the way; the others are reasons to skip. */
  action: "create" | "already" | "conflict";
  /** The label already in the workspace, when one was found. */
  existing?: WorkspaceLabel;
  matchedBy?: MatchKind;
}

/**
 * Decides what to do with one workspace, given the labels it already has.
 *
 * Three outcomes, and the distinction between the last two matters:
 *
 * - `already` — the workspace has this custom label. Creating it again would
 *   be rejected as a duplicate, or worse, leave two near-identical labels.
 * - `conflict` — a Plusvibe built-in label owns this exact name. The API
 *   refuses to reuse a system name, so there is nothing to do here but pick a
 *   different name.
 * - `create` — go ahead.
 *
 * System labels are matched on the exact name only, never on the normalized
 * one. "🤑 meeting booked" and the built-in "Meeting Booked" normalize
 * identically, and they are deliberately different labels — treating the
 * built-in as a conflict would block the single most common label in use.
 */
export function classifyWorkspace(
  name: string,
  labels: WorkspaceLabel[]
): Classification {
  const wantedExact = name.trim().toLowerCase();
  const wantedNorm = normalizeLabelName(name);

  let similar: WorkspaceLabel | undefined;

  for (const label of labels) {
    const exact = label.name.trim().toLowerCase();
    if (exact && exact === wantedExact) {
      // An exact hit is definitive either way, so it ends the search.
      return label.isSystem
        ? { action: "conflict", existing: label, matchedBy: "exact" }
        : { action: "already", existing: label, matchedBy: "exact" };
    }
    if (
      !label.isSystem &&
      !similar &&
      wantedNorm !== "" &&
      normalizeLabelName(label.name) === wantedNorm
    ) {
      // Held rather than returned: an exact match later in the list wins.
      similar = label;
    }
  }

  if (similar) {
    return { action: "already", existing: similar, matchedBy: "similar" };
  }
  return { action: "create" };
}
