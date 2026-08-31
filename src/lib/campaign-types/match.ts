import { deriveNames } from "./names";

// Maps one source campaign onto the three companions the user created by hand
// in Plusvibe.
//
// The names are derived from the source, so the match is exact by design:
//
//   Tree Removal - August             (source, picked)
//   🔵 Tree Removal - August          (blue)
//   Tree Removal - Opt Out - August   (optOut)
//   🔵 Tree Removal - Opt Out - August (blueOptOut)
//
// Matching is forgiving about the things a human duplicating a campaign gets
// wrong — case, doubled spaces, a missing space after the emoji, a variation
// selector on the emoji — but never about which campaign it is. Anything it
// can't match is reported so the UI can ask, rather than guessed at: picking
// the wrong campaign here moves thousands of leads into it.

export type MatchRole = "blue" | "optOut" | "blueOptOut";

export interface CampaignLike {
  id: string;
  name: string;
  campaignType?: string;
  /** Plusvibe's status, e.g. ACTIVE / DRAFTED / PAUSED / ARCHIVED. */
  status?: string;
}

/**
 * Archived campaigns can't take leads — `/lead/add` refuses with "Campaign is
 * archived" — and Plusvibe hides them in its own UI while still returning them
 * from /campaign/list-all. So a name belonging to one is, for our purposes, a
 * free name.
 */
export function isArchived(campaign: { status?: string }): boolean {
  return (campaign.status ?? "").trim().toUpperCase() === "ARCHIVED";
}

/**
 * Names already taken in the workspace, mapped to the campaign that holds them.
 *
 * This is what makes a repeated or resumed run safe: a name already here is
 * adopted rather than duplicated a second time.
 *
 * Archived campaigns are deliberately left out. Adopting one looks like a
 * successful reuse and then fails at the first lead — the run gets as far as
 * creating and editing the copies, reports "3 / 3 campaigns · 1 reused", and
 * dies on "Campaign is archived" with nothing moved. Treating the name as free
 * makes a new campaign under it instead, which is what archiving the old one
 * was for.
 *
 * A live campaign always wins over an archived one with the same name, since
 * the archived ones never enter the map at all.
 */
export function buildReuseIndex(
  campaigns: CampaignLike[]
): Map<string, string> {
  const byName = new Map<string, string>();
  for (const c of campaigns) {
    if (c.campaignType === "subseq") continue;
    if (isArchived(c)) continue;
    const key = normalizeName(c.name);
    if (key && c.id && !byName.has(key)) byName.set(key, c.id);
  }
  return byName;
}

export interface RoleMatch {
  role: MatchRole;
  expectedName: string;
  /** The campaign found, or null when nothing matched. */
  match: CampaignLike | null;
  /** More than one campaign shares the name — ambiguous, so left unmatched. */
  ambiguous: boolean;
  /**
   * True when only the loose comparison matched, i.e. the stored name differs
   * from the expected one by separators alone ("Tree Removal - (August)" vs
   * "Tree Removal (August)"). Surfaced so the UI can ask for a second look.
   */
  loose?: boolean;
}

export interface MatchResult {
  matches: RoleMatch[];
  /** True when all three companions were found unambiguously. */
  complete: boolean;
}

/**
 * Normalises a name for comparison only — never for display or writing.
 *
 * Strips the emoji variation selector (U+FE0F), which is invisible but makes
 * "🔵" and "🔵️" different strings, then collapses whitespace and case.
 */
export function normalizeName(name: string): string {
  return name
    .replace(/️/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Comparison key that also ignores hyphen separators, so a name carrying a
 * stray dash still matches:
 *
 *   "🔵 Tree Removal - (August)"  ~  "🔵 Tree Removal (August)"
 *
 * Only used when the exact comparison finds nothing, and only when it picks out
 * exactly one campaign — it loosens punctuation, never identity. The words and
 * the parenthetical still have to agree.
 */
export function looseKey(name: string): string {
  return normalizeName(name).replace(/-/g, " ").replace(/\s+/g, " ").trim();
}

export function matchCompanions(
  sourceName: string,
  campaigns: CampaignLike[],
  sourceId?: string
): MatchResult {
  const names = deriveNames(sourceName);
  // Sub-sequences are separate campaign records; they are never a role here.
  const pool = campaigns.filter(
    (c) => c.campaignType !== "subseq" && c.id !== sourceId
  );

  const byName = new Map<string, CampaignLike[]>();
  const byLoose = new Map<string, CampaignLike[]>();
  for (const c of pool) {
    for (const [map, key] of [
      [byName, normalizeName(c.name)],
      [byLoose, looseKey(c.name)],
    ] as const) {
      const list = map.get(key);
      if (list) list.push(c);
      else map.set(key, [c]);
    }
  }

  const roles: { role: MatchRole; expectedName: string }[] = [
    { role: "blue", expectedName: names.blue },
    { role: "optOut", expectedName: names.optOut },
    { role: "blueOptOut", expectedName: names.blueOptOut },
  ];

  const used = new Set<string>();
  const matches: RoleMatch[] = roles.map(({ role, expectedName }) => {
    const exact = byName.get(normalizeName(expectedName)) ?? [];
    // Two campaigns with the same name: we can't tell which is meant.
    if (exact.length > 1) {
      return { role, expectedName, match: null, ambiguous: true };
    }

    let candidate = exact[0];
    let loose = false;

    // Fall back to the punctuation-insensitive key only when the exact name
    // found nothing, and only when it resolves to a single campaign.
    if (!candidate) {
      const near = (byLoose.get(looseKey(expectedName)) ?? []).filter(
        (c) => !used.has(c.id)
      );
      if (near.length > 1) {
        return { role, expectedName, match: null, ambiguous: true };
      }
      candidate = near[0];
      loose = !!candidate;
    }

    // One campaign can't fill two roles — that would move the same leads twice.
    if (!candidate || used.has(candidate.id)) {
      return { role, expectedName, match: null, ambiguous: false };
    }
    used.add(candidate.id);
    return { role, expectedName, match: candidate, ambiguous: false, loose };
  });

  return { matches, complete: matches.every((m) => m.match !== null) };
}
