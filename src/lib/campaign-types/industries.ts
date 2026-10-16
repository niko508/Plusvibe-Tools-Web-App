// Create All Campaign Types: saved industries and the segments each one uses.
//
// An industry is added by name from its dropdown, with or without segments.
// Picking one fills the segment rows with the segments last used for it, and — where the name of exactly one picked original contains the
// segment — the campaign beside it. A run started under an industry saves the
// segments it used, so the next run for that industry starts from them.
//
// Pure module: the reading, the saving rules and the matching, all unit-tested.

import { MAX_SEGMENTS } from "./segments";
import { nameHolds } from "./add-leads";
import { BLUE, stripYellow } from "./names";

/** Segments saved per industry: as many as the page has rows for. */
export const MAX_INDUSTRY_SEGMENTS = MAX_SEGMENTS;
export const MAX_INDUSTRIES = 300;
const MAX_NAME = 80;

export interface Industry {
  name: string;
  /** In row order. */
  segments: string[];
  /** The segment whose campaign takes the leads with no segment, if one was chosen. */
  noSegment?: string;
  /**
   * Learned from Add More Leads: segment (lower-case) → the family name picked
   * for it by hand, without its marker and month ("app" → "Apps"). Next time
   * the newest campaign of that name is found for it.
   */
  families?: Record<string, string>;
  updatedAt: number;
}

const MAX_FAMILIES = 60;

function cleanFamilies(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, MAX_FAMILIES)) {
    const seg = key(k).slice(0, MAX_NAME);
    const fam = typeof v === "string" ? tidy(v).slice(0, 200) : "";
    if (seg && fam) out[seg] = fam;
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
    const families = cleanFamilies(o.families);
    seen.add(key(name));
    out.push({ name, segments, ...(noSegment ? { noSegment } : {}), ...(families ? { families } : {}), updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : 0 });
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
  input: { name: string; segments: string[]; noSegment?: string | null; families?: Record<string, string> },
  now: number
): { list: Industry[]; saved: Industry | null; problem?: string } {
  const name = tidy(input.name ?? "").slice(0, MAX_NAME);
  if (!name) return { list, saved: null, problem: "Type the industry's name." };
  // Added from the dropdown before any segment is typed: saved with none.
  const segments = cleanSegments(input.segments ?? []);
  const noSegment = input.noSegment ? segments.find((s) => key(s) === key(input.noSegment!)) : undefined;
  const existing = findIndustry(list, name);
  // What was learned is kept unless something new is learned: saving the
  // segments from another tab must not forget it.
  const families = cleanFamilies({ ...(existing?.families ?? {}), ...(input.families ?? {}) });
  const saved: Industry = { name: existing?.name ?? name, segments, ...(noSegment ? { noSegment } : {}), ...(families ? { families } : {}), updatedAt: now };
  const rest = list.filter((i) => i !== existing);
  if (!existing && rest.length >= MAX_INDUSTRIES) return { list, saved: null, problem: `There are already ${MAX_INDUSTRIES} industries saved. Remove one first.` };
  return { list: [saved, ...rest], saved };
}

export function removeIndustry(list: Industry[], name: string): Industry[] {
  const found = findIndustry(list, name);
  return found ? list.filter((i) => i !== found) : list;
}

export function matchCampaign(segment: string, campaigns: { id: string; name: string }[]): string | null {
  if (!segment.trim()) return null;
  const hits = campaigns.filter((c) => nameHolds(c.name, segment));
  return hits.length === 1 ? hits[0].id : null;
}

/** A campaign name without its 🟡/🔵 circle and trailing "(Month)", for comparing. */
function bareCampaignName(name: string): string {
  return key(stripYellow(name).replace(new RegExp(`^${BLUE}\\uFE0F?\\s*`), "").replace(/\s*\([^()]*\)\s*$/, ""));
}

/**
 * The saved industry a campaign is named for: its name starts with the
 * industry's, followed by nothing or by " - " ("Medical Practices & Clinics -
 * Cash Pay (August)" is "Medical Practices & Clinics"). The longest such name
 * wins, so "Health & Wellness - Clinics" beats "Health & Wellness". None
 * found: null, and the industry is picked by hand.
 */
export function industryForCampaign(campaignName: string, list: Industry[]): Industry | null {
  const bare = bareCampaignName(campaignName);
  if (!bare) return null;
  let best: Industry | null = null;
  for (const i of list) {
    const k = key(i.name);
    if (!k) continue;
    if (bare !== k && !bare.startsWith(`${k} - `)) continue;
    if (!best || k.length > key(best.name).length) best = i;
  }
  return best;
}
