// Create All Campaign Types: saved industries and the segments each one uses.
//
// An industry is added by name from its dropdown, with or without segments.
// Picking one fills the segment rows with the segments last used for it, and — where the name of exactly one picked original contains the
// segment — the campaign beside it. A run started under an industry saves the
// segments it used, so the next run for that industry starts from them.
//
// Pure module: the reading, the saving rules and the matching, all unit-tested.

import { MAX_RULES } from "./segments";

/** Segment rows on the page, besides the one for leads with no segment. */
export const MAX_INDUSTRY_SEGMENTS = MAX_RULES - 1;
export const MAX_INDUSTRIES = 300;
const MAX_NAME = 80;

export interface Industry {
  name: string;
  /** In row order. */
  segments: string[];
  /** The segment whose campaign takes the leads with no segment, if one was chosen. */
  noSegment?: string;
  updatedAt: number;
}

const key = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
const tidy = (s: string) => s.replace(/\s+/g, " ").trim();

/** A saved list read defensively: bad rows dropped, names unique, most recent first. */
export function normalizeIndustries(raw: unknown): Industry[] {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const out: Industry[] = [];
  for (const item of list) {
    const o = (item ?? {}) as Record<string, unknown>;
    const name = typeof o.name === "string" ? tidy(o.name).slice(0, MAX_NAME) : "";
    if (!name || seen.has(key(name))) continue;
    const segments = cleanSegments(Array.isArray(o.segments) ? o.segments : []);
    const noSegment = typeof o.noSegment === "string" ? segments.find((s) => key(s) === key(o.noSegment as string)) : undefined;
    seen.add(key(name));
    out.push({ name, segments, ...(noSegment ? { noSegment } : {}), updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : 0 });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_INDUSTRIES);
}

function cleanSegments(raw: unknown[]): string[] {
  const out: string[] = [];
  for (const s of raw) {
    if (typeof s !== "string") continue;
    const t = tidy(s).slice(0, MAX_NAME);
    if (t && !out.some((x) => key(x) === key(t))) out.push(t);
  }
  return out.slice(0, MAX_INDUSTRY_SEGMENTS);
}

export function findIndustry(list: Industry[], name: string): Industry | undefined {
  const k = key(name);
  return k ? list.find((i) => key(i.name) === k) : undefined;
}

/**
 * The list with one industry saved: a new one added, an existing one (however
 * it is capitalised) given the new segments under its original spelling.
 */
export function saveIndustry(
  list: Industry[],
  input: { name: string; segments: string[]; noSegment?: string | null },
  now: number
): { list: Industry[]; saved: Industry | null; problem?: string } {
  const name = tidy(input.name ?? "").slice(0, MAX_NAME);
  if (!name) return { list, saved: null, problem: "Type the industry's name." };
  // Added from the dropdown before any segment is typed: saved with none.
  const segments = cleanSegments(input.segments ?? []);
  const noSegment = input.noSegment ? segments.find((s) => key(s) === key(input.noSegment!)) : undefined;
  const existing = findIndustry(list, name);
  const saved: Industry = { name: existing?.name ?? name, segments, ...(noSegment ? { noSegment } : {}), updatedAt: now };
  const rest = list.filter((i) => i !== existing);
  if (!existing && rest.length >= MAX_INDUSTRIES) return { list, saved: null, problem: `There are already ${MAX_INDUSTRIES} industries saved. Remove one first.` };
  return { list: [saved, ...rest], saved };
}

export function removeIndustry(list: Industry[], name: string): Industry[] {
  const found = findIndustry(list, name);
  return found ? list.filter((i) => i !== found) : list;
}

/** "Free Trial - Everyday" → "free trial everyday": words only, for matching. */
const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * The picked original a segment most likely belongs to: the one campaign whose
 * name contains the segment as whole words. None, or more than one, is no
 * answer — the row is left for choosing by hand.
 */
export function matchCampaign(segment: string, campaigns: { id: string; name: string }[]): string | null {
  const w = words(segment);
  if (!w) return null;
  const hits = campaigns.filter((c) => ` ${words(c.name)} `.includes(` ${w} `));
  return hits.length === 1 ? hits[0].id : null;
}
