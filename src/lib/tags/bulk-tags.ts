// Creating the same tags across many workspaces.
//
// Tags organise email accounts and campaigns. Names are case-insensitive and
// unique per workspace; every tag needs a hex colour; a description is
// optional. Pure module: the rules, the batch de-duplication and the
// per-workspace decision, with no API calls, so all of it is unit-tested.

export interface TagInput {
  name: string;
  color: string;
  description?: string;
}

/** A tag ready to send: trimmed, colour normalised to #RRGGBB upper-case. */
export interface TagSpec {
  name: string;
  color: string;
  description?: string;
}

export const MAX_TAG_NAME_LENGTH = 100;
export const MAX_TAG_DESCRIPTION_LENGTH = 500;

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * "#f57" → "#FF5577", "#ff5733" → "#FF5733". Null when it isn't a colour.
 * The API accepts both forms; normalising means two spellings of one colour
 * compare equal and the results table shows one shape.
 */
export function normalizeColor(raw: string): string | null {
  const c = raw.trim();
  if (!HEX_RE.test(c)) return null;
  const hex = c.slice(1);
  const full = hex.length === 3 ? hex.split("").map((h) => h + h).join("") : hex;
  return `#${full.toUpperCase()}`;
}

/** Comparison key for a tag name — Plusvibe treats names case-insensitively. */
export function tagKey(name: string): string {
  return name.trim().toLowerCase();
}

/** Problems with one tag, in reading order. Empty when fine. */
export function validateTag(t: TagInput): string[] {
  const problems: string[] = [];
  const name = t.name.trim();
  if (name === "") problems.push("Give the tag a name.");
  else if (name.length > MAX_TAG_NAME_LENGTH) {
    problems.push(`The name is ${name.length} characters; the limit is ${MAX_TAG_NAME_LENGTH}.`);
  }
  if (normalizeColor(t.color) === null) {
    problems.push("The colour needs to be a hex code like #FF5733 or #F57.");
  }
  if ((t.description ?? "").trim().length > MAX_TAG_DESCRIPTION_LENGTH) {
    problems.push(`The description is over ${MAX_TAG_DESCRIPTION_LENGTH} characters.`);
  }
  return problems;
}

export interface BatchResult {
  /** Tags to send, in the order given, with duplicates within the batch dropped. */
  specs: TagSpec[];
  /** Problems keyed by the input's position. */
  problems: Map<number, string[]>;
  /** Positions dropped because an earlier row has the same name. */
  duplicates: number[];
}

/**
 * Validates a whole batch. Rows with problems are reported, not silently
 * dropped; a name repeated within the batch keeps its first occurrence — the
 * API would refuse the second anyway, and it would only read as an error.
 */
export function prepareBatch(inputs: TagInput[]): BatchResult {
  const specs: TagSpec[] = [];
  const problems = new Map<number, string[]>();
  const duplicates: number[] = [];
  const seen = new Set<string>();
  inputs.forEach((t, i) => {
    const p = validateTag(t);
    if (p.length > 0) {
      problems.set(i, p);
      return;
    }
    const key = tagKey(t.name);
    if (seen.has(key)) {
      duplicates.push(i);
      return;
    }
    seen.add(key);
    const description = (t.description ?? "").trim();
    specs.push({
      name: t.name.trim(),
      color: normalizeColor(t.color) as string,
      ...(description ? { description } : {}),
    });
  });
  return { specs, problems, duplicates };
}

// --- Removing --------------------------------------------------------------
//
// Removal is by NAME, like adding — the ids differ per workspace, so the tool
// looks each name up where it is being removed. A name the workspace doesn't
// have is "missing", not an error: removing a tag from twenty workspaces
// where only twelve have it is the normal case.

export interface RemoveBatch {
  /** Names to remove, trimmed, first occurrence of each kept. */
  names: string[];
  /** Positions dropped because an earlier row names the same tag. */
  duplicates: number[];
  /** Problems keyed by the input's position. */
  problems: Map<number, string[]>;
}

export function prepareRemoveBatch(inputs: { name: string }[]): RemoveBatch {
  const names: string[] = [];
  const duplicates: number[] = [];
  const problems = new Map<number, string[]>();
  const seen = new Set<string>();
  inputs.forEach((t, i) => {
    const name = t.name.trim();
    if (name === "") {
      problems.set(i, ["Give the tag a name."]);
      return;
    }
    if (name.length > MAX_TAG_NAME_LENGTH) {
      problems.set(i, [`The name is ${name.length} characters; the limit is ${MAX_TAG_NAME_LENGTH}.`]);
      return;
    }
    const key = tagKey(name);
    if (seen.has(key)) {
      duplicates.push(i);
      return;
    }
    seen.add(key);
    names.push(name);
  });
  return { names, duplicates, problems };
}

export type TagOutcome = "created" | "already" | "error" | "removed" | "missing";

/**
 * Whether a workspace already has a tag of this name. Case-insensitive, like
 * the API's uniqueness rule, so "vip clients" is "VIP Clients".
 */
export function findExisting<T extends { name: string }>(
  name: string,
  existing: T[]
): T | undefined {
  const key = tagKey(name);
  return existing.find((t) => tagKey(t.name) === key);
}

/** Sorts an API failure: a duplicate-name refusal is "already", not an error. */
export function classifyApiError(message: string): TagOutcome {
  return /already exists/i.test(message) ? "already" : "error";
}
