// Add More Leads: a new batch lands in one campaign, and every lead goes to
// the family its segment names — found by name in the workspace — then is
// split across that family's copies by mailbox provider, as a Move leads run
// does.
//
//   the source         the campaign the batch was uploaded to. Its leads
//                      without a segment, or with one no row lists, stay in
//                      its family and are split there.
//   a segment's family the newest original whose name contains the segment
//                      (whole words, any case): "apps" → "🟡 Apps (August)".
//                      Newest by the month in the name — every campaign is
//                      named with one — and by creation time within a month.
//                      Only the leads moved into it are split; what it held
//                      already stays where it is.
//
// Pure module: no API calls, so all of it is unit-tested.

import { BLUE, hasOptOut, hasSignature, stripYellow, withoutOptOut } from "./names";
import { normalizeName } from "./match";
import { isArchived } from "./match";

export interface CampaignLite {
  id: string;
  name: string;
  status?: string;
  campaignType?: string;
  createdAt?: number;
}

const live = (c: CampaignLite) => c.campaignType !== "subseq" && !isArchived(c);
const plainSide = (c: CampaignLite) => !c.name.trim().startsWith(BLUE) && !hasSignature(c.name);

/** An original: live, not a sub-sequence, and not one of the 🔵, Opt Out or Signature copies. */
export function isOriginal(c: CampaignLite): boolean {
  return live(c) && plainSide(c) && !hasOptOut(c.name);
}

/**
 * The workspace's originals. Besides the plain ones, an Opt Out campaign is
 * one when no plain campaign of the same name sits beside it: its family was
 * built with Opt Out only, which turns the original itself into the Opt Out
 * campaign ("🟡 SaaS - Sales Led - Opt Out (August)").
 */
export function originalsOf<T extends CampaignLite>(campaigns: T[]): T[] {
  // With or without the 🟡: both spellings are in use.
  const key = (name: string) => normalizeName(stripYellow(name));
  const plain = new Set(campaigns.filter((c) => live(c) && isOriginal(c)).map((c) => key(c.name)));
  return campaigns.filter((c) => live(c) && plainSide(c) && (!hasOptOut(c.name) || !plain.has(key(withoutOptOut(c.name)))));
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** A MongoDB-style id carries its creation second in its first 8 hex digits. */
function idTime(id: string): number {
  if (!/^[0-9a-f]{24}$/i.test(id)) return 0;
  const s = parseInt(id.slice(0, 8), 16);
  return Number.isFinite(s) && s > 1_400_000_000 ? s * 1000 : 0;
}

/** "(August)" → 8; 0 when the name carries no month. A month name anywhere in the name counts, the last one winning. */
export function monthOf(name: string): number {
  let found = 0;
  for (const w of name.toLowerCase().match(/[a-z]+/g) ?? []) {
    const i = MONTHS.indexOf(w);
    if (i >= 0) found = i + 1;
  }
  return found;
}

/**
 * How recent a month is, as of `now`: this month 12, last month 11, … A month
 * after this one is last year's — "(December)" in January is a month old.
 * 0 when there is no month.
 */
export function monthRecency(month: number, now: Date): number {
  if (!month) return 0;
  const current = now.getMonth() + 1;
  return 12 - ((current - month + 12) % 12);
}

/**
 * How new a campaign is, as a sortable key: the month in its name first —
 * that is how campaigns are named — then the time Plusvibe gives or the time
 * in its id, then its place in the list.
 */
export function newness(c: CampaignLite, index: number, now: Date = new Date()): [number, number, number] {
  return [monthRecency(monthOf(c.name), now), c.createdAt ?? idTime(c.id), index];
}

function newer(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

const wordList = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

/** One word for another, a plural either way: "app" ~ "apps", "service" ~ "services", "business" ~ "businesses". */
function sameWord(a: string, b: string): boolean {
  return a === b || a + "s" === b || a + "es" === b || b + "s" === a || b + "es" === a;
}

/** The segment's words, in order, somewhere in the name's — a plural either way. */
export function nameHolds(name: string, segment: string): boolean {
  const n = wordList(name);
  const w = wordList(segment);
  if (w.length === 0) return false;
  for (let i = 0; i + w.length <= n.length; i++) if (w.every((x, j) => sameWord(x, n[i + j]))) return true;
  return false;
}

/**
 * A family's name without its marker or its month: "🟡 Apps (August)" →
 * "Apps". What is remembered, so a later month's campaign is found too.
 */
export function familyBase(name: string): string {
  return name
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Every original named for the segment, newest first: those carrying the
 * remembered family name when there is one, else those whose name holds the
 * segment's words (whole words, any case, a plural either way).
 */
export function familiesFor(segment: string, originals: CampaignLite[], now: Date = new Date(), remembered?: string): CampaignLite[] {
  const byMemory = remembered ? originals.filter((c) => familyBase(c.name).toLowerCase() === remembered.trim().toLowerCase()) : [];
  const pool = byMemory.length > 0 ? byMemory : originals.filter((c) => nameHolds(c.name, segment));
  if (pool.length === 0) return [];
  const withKey = pool.map((c) => ({ c, key: newness(c, originals.indexOf(c), now) }));
  withKey.sort((a, b) => (newer(a.key, b.key) ? -1 : newer(b.key, a.key) ? 1 : 0));
  return withKey.map((x) => x.c);
}

export interface AddLeadsRow {
  segment: string;
  /** Leads in the source carrying it; null before the leads have been read. */
  count: number | null;
  /** Listed by the industry (true), or only found in the leads (false). */
  fromIndustry: boolean;
  /** The family its leads go to, or null when none was found or picked. */
  familyId: string | null;
  familyName: string | null;
  /** Found by name (true) or picked by hand (false). */
  auto: boolean;
  /** Found through what was picked by hand for this segment before. */
  remembered: boolean;
  /** How many originals matched the name, so "picked the newest of 3" can be said. */
  candidates: number;
  /** The family is the source's own: its leads stay and are split there. */
  isSource: boolean;
}

export interface AddLeadsPlan {
  rows: AddLeadsRow[];
  /** What the run is sent: a rule per segment with a family. */
  rules: { segment: string; campaignId: string; campaignName: string }[];
  /** Families other than the source's that take leads — only the ones moved in are split. */
  arrivalFamilies: CampaignLite[];
  /** What stops the run. */
  problems: string[];
  /** What the run will do that may not be wanted, without stopping it. */
  warnings: string[];
}

/**
 * The run for one source and an industry's segments. `picked` holds families
 * chosen by hand, by segment (lower-case); anything else is found by name.
 */
export function planAddLeads(
  source: CampaignLite | null,
  segments: string[],
  originals: CampaignLite[],
  picked: Record<string, string> = {},
  /** What the source's leads carry, once read: segments the industry doesn't list are added. */
  found: SegmentCount[] | null = null,
  /** Learned before: segment (lower-case) → family name picked for it by hand. */
  remembered: Record<string, string> = {}
): AddLeadsPlan {
  const problems: string[] = [];
  if (!source) problems.push("Pick the campaign the new leads are in.");
  const seen = new Set<string>();
  const rows: AddLeadsRow[] = [];
  const countOf = (key: string) => (found ? found.find((f) => f.segment.toLowerCase() === key)?.count ?? 0 : null);
  const listed = segments.map((s) => ({ raw: s, fromIndustry: true }));
  const extra = (found ?? []).filter((f) => f.segment !== "").map((f) => ({ raw: f.segment, fromIndustry: false }));
  for (const { raw, fromIndustry } of [...listed, ...extra]) {
    const segment = raw.replace(/\s+/g, " ").trim();
    const key = segment.toLowerCase();
    if (!segment || seen.has(key)) continue;
    seen.add(key);
    const memory = remembered[key];
    const matched = familiesFor(segment, originals, new Date(), memory);
    const byMemory = !!memory && matched.length > 0 && familyBase(matched[0].name).toLowerCase() === memory.toLowerCase();
    const hand = picked[key] ? originals.find((c) => c.id === picked[key]) : undefined;
    // The source is always an option for its own segment, even if its name doesn't say it.
    const chosen = hand ?? (matched[0] as CampaignLite | undefined);
    rows.push({
      segment,
      count: countOf(key),
      fromIndustry,
      familyId: chosen?.id ?? null,
      familyName: chosen?.name ?? null,
      auto: !hand,
      remembered: !hand && byMemory,
      candidates: matched.length,
      isSource: !!chosen && !!source && chosen.id === source.id,
    });
  }
  const warnings: string[] = [];
  for (const r of rows) {
    if (r.familyId || r.count === 0) continue;
    warnings.push(
      `Couldn't find a campaign for "${r.segment}"${r.count ? ` (${r.count} lead${r.count === 1 ? "" : "s"})` : ""}, so ${r.count === 1 ? "it stays" : "they stay"} in ${source?.name ?? "the source"} unless you pick where ${r.count === 1 ? "it goes" : "they go"}.`
    );
  }

  const rules = source
    ? rows.filter((r) => r.familyId && r.count !== 0).map((r) => ({ segment: r.segment, campaignId: r.familyId!, campaignName: r.familyName! }))
    : [];
  const arrivalIds = new Set(rules.filter((r) => r.campaignId !== source?.id).map((r) => r.campaignId));
  const arrivalFamilies = originals.filter((c) => arrivalIds.has(c.id));
  return { rows, rules, arrivalFamilies, problems, warnings };
}

// --- What the source's leads carry --------------------------------------------

export interface SegmentCount {
  /** As the leads spell it most often; "" for leads with none. */
  segment: string;
  count: number;
}

/** Leads per segment, case and spacing ignored, most first; the empty one last. */
export function countSegments(values: string[]): SegmentCount[] {
  const byKey = new Map<string, { spellings: Map<string, number>; count: number }>();
  for (const v of values) {
    const spelled = (v ?? "").replace(/\s+/g, " ").trim();
    const key = spelled.toLowerCase();
    const e = byKey.get(key) ?? { spellings: new Map(), count: 0 };
    e.count += 1;
    e.spellings.set(spelled, (e.spellings.get(spelled) ?? 0) + 1);
    byKey.set(key, e);
  }
  return [...byKey.entries()]
    .map(([key, e]) => ({
      segment: key === "" ? "" : [...e.spellings.entries()].sort((a, b) => b[1] - a[1])[0][0],
      count: e.count,
    }))
    .sort((a, b) => (a.segment === "" ? 1 : b.segment === "" ? -1 : b.count - a.count));
}
