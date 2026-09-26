// Creating one additional field across many workspaces.
//
// Additional fields are Plusvibe's workspace-level custom lead fields — the
// columns beyond email / first name / company that a workspace's leads can
// carry, and that copy can reference as {{industry}} and the like.
//
// Pure module: the name rules, the normalization Plusvibe applies, and the
// decision of what to do with each workspace, with no API calls — so all of it
// is unit-testable and the route stays thin.

/** One field as a workspace reports it. */
export interface WorkspaceField {
  /** Already normalized by Plusvibe: lowercase, underscores. */
  name: string;
  default_value?: string;
}

/**
 * The normalization Plusvibe applies to a field name.
 *
 * The docs say "lowercase, spaces/special characters become underscores" and
 * the list endpoint returns names already in that form. So "Industry Type"
 * becomes `industry_type`, and that is the name copy has to use.
 *
 * Runs of separators collapse to one underscore and the ends are trimmed. The
 * docs don't say whether Plusvibe does that too — so this is used for
 * COMPARISON, applied to both sides, which makes the match right either way.
 * The name actually sent to the API is the user's, untouched, and the API does
 * its own normalizing.
 */
export function normalizeFieldName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Standard lead fields every workspace has. A field can't reuse these names —
 * the API refuses with "Field name should not be same as Standard Field".
 *
 * Only the ones the docs name outright plus the obvious siblings. The API is
 * the authority; anything it rejects that isn't listed here still comes back
 * as a clear "conflict" outcome rather than a generic error.
 */
export const STANDARD_FIELDS = new Set([
  "email",
  "first_name",
  "last_name",
  "company_name",
  "phone",
  "website",
]);

export const MAX_FIELD_NAME_LENGTH = 100;

/**
 * Everything wrong with a field name, in the order worth reading.
 *
 * Returns an empty array when the name is fine.
 */
export function validateFieldName(name: string): string[] {
  const trimmed = name.trim();
  if (trimmed === "") return ["Give the field a name."];

  const problems: string[] = [];
  const norm = normalizeFieldName(trimmed);

  if (norm === "") {
    problems.push(
      "The name needs at least one letter or number — everything else becomes an underscore."
    );
  }
  if (STANDARD_FIELDS.has(norm)) {
    problems.push(
      `"${norm}" is a standard lead field every workspace already has, so it can't be added again.`
    );
  }
  if (trimmed.length > MAX_FIELD_NAME_LENGTH) {
    problems.push(
      `The name is ${trimmed.length} characters; keep it under ${MAX_FIELD_NAME_LENGTH}.`
    );
  }
  return problems;
}

export type FieldOutcome = "created" | "already" | "conflict" | "error";

export interface Classification {
  /** "create" means nothing in the way; "already" means skip it. */
  action: "create" | "already";
  existing?: WorkspaceField;
}

/**
 * Decides what to do with one workspace, given the fields it already has.
 *
 * Both sides are normalized before comparing, so "Industry Type" matches an
 * existing `industry_type` — which is what the API would otherwise reject as
 * "Field already exists on Workspace". Skipping is the right answer: the field
 * is there, and there is nothing to change (the name is immutable).
 */
export function classifyWorkspace(
  name: string,
  fields: WorkspaceField[]
): Classification {
  const wanted = normalizeFieldName(name);
  const existing = fields.find((f) => normalizeFieldName(f.name) === wanted);
  return existing ? { action: "already", existing } : { action: "create" };
}

/**
 * Sorts an API failure into the outcome it deserves.
 *
 * The API's own wording is what tells a real error apart from a name that
 * simply can't be used: "Standard Field" and "campaign variable" clashes are
 * conflicts — the same for every workspace, and fixed by picking a different
 * name — not failures of the request.
 */
export function classifyApiError(message: string): FieldOutcome {
  const m = message.toLowerCase();
  if (m.includes("standard field")) return "conflict";
  if (m.includes("campaign variable")) return "conflict";
  // A race with a concurrent create, or a listing that lagged behind. The
  // field exists, so "already" is both true and the outcome the user wants.
  if (m.includes("already exists")) return "already";
  return "error";
}
