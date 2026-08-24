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
}

export interface RoleMatch {
  role: MatchRole;
  expectedName: string;
  /** The campaign found, or null when nothing matched. */
  match: CampaignLike | null;
  /** More than one campaign shares the name — ambiguous, so left unmatched. */
  ambiguous: boolean;
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
  for (const c of pool) {
    const key = normalizeName(c.name);
    const list = byName.get(key);
    if (list) list.push(c);
    else byName.set(key, [c]);
  }

  const roles: { role: MatchRole; expectedName: string }[] = [
    { role: "blue", expectedName: names.blue },
    { role: "optOut", expectedName: names.optOut },
    { role: "blueOptOut", expectedName: names.blueOptOut },
  ];

  const used = new Set<string>();
  const matches: RoleMatch[] = roles.map(({ role, expectedName }) => {
    const found = byName.get(normalizeName(expectedName)) ?? [];
    // Two campaigns with the same name: we can't tell which is meant.
    if (found.length > 1) {
      return { role, expectedName, match: null, ambiguous: true };
    }
    const candidate = found[0];
    // One campaign can't fill two roles — that would move the same leads twice.
    if (!candidate || used.has(candidate.id)) {
      return { role, expectedName, match: null, ambiguous: false };
    }
    used.add(candidate.id);
    return { role, expectedName, match: candidate, ambiguous: false };
  });

  return { matches, complete: matches.every((m) => m.match !== null) };
}
