// Fix Allocation: putting leads where they should have gone.
//
// A segment row that covered nothing leaves its leads in the wrong family —
// and not in the campaign they were picked from either, because the split has
// already sent them on to that family's copies. Getting them back means
// reading whichever campaigns now hold them and moving the ones carrying a
// given segment into the family they belong to.
//
// Two things make this different from a normal run, and both matter:
//
//   Sources are READ, nothing more. No names are derived from them, no copies
//   are made, nothing is moved into them. That is what makes it safe to pick a
//   copy as a source — which a normal run must never do, since the names
//   derived from "🔵 X" resolve to X's own siblings.
//
//   Destinations are PICKED, one per part, and each one's part is read off its
//   own name rather than derived from a parent. Nothing here guesses which
//   campaign was meant.
//
// The leads are then divided exactly as a normal run divides them, so a family
// filled this way is indistinguishable from one filled the first time round.
//
// Pure module — no API — so all of it is unit-tested.

import { hasOptOut, hasSignature } from "@/lib/campaign-types/names";
import { splitCountsFor, type Availability, type Destination as SplitRole } from "@/lib/campaign-types/split";

/** The part a campaign plays in a family. Same six the split knows. */
export type AllocRole = SplitRole;

export const ALLOC_ROLES: AllocRole[] = [
  "source",
  "blue",
  "optOut",
  "blueOptOut",
  "signature",
  "blueSignature",
];

export const ALLOC_ROLE_LABELS: Record<AllocRole, string> = {
  source: "Google / other",
  blue: "Microsoft",
  optOut: "Google / other · opt-out",
  blueOptOut: "Microsoft · opt-out",
  signature: "Google / other · signature",
  blueSignature: "Microsoft · signature",
};

/** A leading blue circle, with or without the invisible variation selector. */
const LEADING_BLUE = /^🔵️?\s*/;

export function hasBlue(name: string): boolean {
  return LEADING_BLUE.test(name.trim());
}

/**
 * The part a campaign plays, from its own name: 🔵 means the Microsoft side,
 * "Opt Out" and "Signature" name the two variants, and anything else is the
 * plain one the rest of its bucket goes to.
 *
 * Read off the campaign itself rather than derived from a parent, so a family
 * whose names drifted apart is still sorted correctly — and so that what each
 * pick will do can be shown before anything moves.
 */
export function roleOfName(name: string): AllocRole {
  const blue = hasBlue(name);
  if (hasOptOut(name)) return blue ? "blueOptOut" : "optOut";
  if (hasSignature(name)) return blue ? "blueSignature" : "signature";
  return blue ? "blue" : "source";
}

export interface AllocDestination {
  campaignId: string;
  campaignName: string;
  role: AllocRole;
}

/**
 * The picked campaigns with the part each one plays.
 *
 * Two campaigns claiming the same part is refused rather than resolved: there
 * is no telling which was meant, and picking one would quietly send half a
 * bucket to a campaign nobody intended.
 */
export function classifyDestinations(
  picked: { campaignId: string; campaignName: string }[]
): { destinations: AllocDestination[]; problems: string[] } {
  const destinations: AllocDestination[] = [];
  const problems: string[] = [];
  const byRole = new Map<AllocRole, string>();
  for (const c of picked) {
    if (!c.campaignId) continue;
    if (destinations.some((d) => d.campaignId === c.campaignId)) continue;
    const role = roleOfName(c.campaignName);
    const taken = byRole.get(role);
    if (taken) {
      problems.push(
        `"${c.campaignName}" and "${taken}" would both take the ${ALLOC_ROLE_LABELS[role]} leads. Un-tick one of them.`
      );
      continue;
    }
    byRole.set(role, c.campaignName);
    destinations.push({ campaignId: c.campaignId, campaignName: c.campaignName, role });
  }
  return { destinations, problems };
}

/** A lead ready to be placed: what it carries, and which bucket it is in. */
export interface AllocLead<T> {
  lead: T;
  segment: string;
  /**
   * On the 🔵 side. That is Microsoft AND anything that could not be resolved
   * to Google — the same rule the normal split uses, so a family filled here
   * is divided exactly as one filled the first time round.
   */
  blue: boolean;
}

export interface AllocMove<T> {
  campaignId: string;
  campaignName: string;
  role: AllocRole;
  leads: T[];
}

export interface AllocPlan<T> {
  moves: AllocMove<T>[];
  /** Carried the segment asked for. */
  matched: number;
  /** Carried it, but its bucket has no campaign picked, so it stays put. */
  stranded: number;
  /** Did not carry it — never touched. */
  skipped: number;
}

/**
 * Which leads go to which picked campaign.
 *
 * Only leads carrying `segment` are placed; the rest are counted and left
 * exactly where they are. A bucket with no campaign picked strands its leads
 * rather than tipping them into the other bucket — a Microsoft lead does not
 * belong in a Google campaign just because that is the one that was picked.
 */
export function planAllocation<T>(
  leads: AllocLead<T>[],
  segment: string,
  destinations: AllocDestination[]
): AllocPlan<T> {
  const want = segment.trim().toLowerCase();
  const mine = want === "" ? [] : leads.filter((l) => l.segment.trim().toLowerCase() === want);
  const skipped = leads.length - mine.length;

  const byRole = new Map<AllocRole, AllocDestination>();
  for (const d of destinations) byRole.set(d.role, d);
  const avail: Availability = {
    blue: byRole.has("blue"),
    blueOptOut: byRole.has("blueOptOut"),
    blueSignature: byRole.has("blueSignature"),
    optOut: byRole.has("optOut"),
    signature: byRole.has("signature"),
  };

  const microsoft = mine.filter((l) => l.blue).map((l) => l.lead);
  const other = mine.filter((l) => !l.blue).map((l) => l.lead);
  const counts = splitCountsFor(microsoft.length, other.length, avail);
  // splitCountsFor assumes the plain campaign is always there, because in a
  // normal run the leads are already sitting in it. Here they are not, so its
  // share only moves if it was picked; otherwise those leads stay put.
  const plain = byRole.get("source");

  const moves: AllocMove<T>[] = [];
  let stranded = 0;
  const take = (role: AllocRole, from: T[], at: number, n: number): number => {
    const d = byRole.get(role);
    if (!d || n <= 0) return at;
    moves.push({ campaignId: d.campaignId, campaignName: d.campaignName, role, leads: from.slice(at, at + n) });
    return at + n;
  };

  let msAt = 0;
  msAt = take("blue", microsoft, msAt, counts.blue);
  msAt = take("blueSignature", microsoft, msAt, counts.blueSignature);
  msAt = take("blueOptOut", microsoft, msAt, counts.blueOptOut);
  // Microsoft leads with no 🔵 campaign picked are counted into `source` by
  // the split, which is right when they are already there and wrong here.
  const strandedMicrosoft = microsoft.length - msAt;
  stranded += strandedMicrosoft;

  let otAt = 0;
  if (plain) {
    const n = counts.source - strandedMicrosoft;
    otAt = take("source", other, otAt, n);
  } else {
    stranded += counts.source - strandedMicrosoft;
    otAt += counts.source - strandedMicrosoft;
  }
  otAt = take("signature", other, otAt, counts.signature);
  otAt = take("optOut", other, otAt, counts.optOut);

  return { moves, matched: mine.length, stranded, skipped };
}

/** "3 to 🔵 Apps (August) · 2 to 🟡 Apps - Opt Out (August)" */
export function describeAllocation<T>(plan: AllocPlan<T>): string {
  const parts = plan.moves
    .filter((m) => m.leads.length > 0)
    .map((m) => `${m.leads.length.toLocaleString()} to ${m.campaignName}`);
  if (parts.length === 0) return "nothing to move";
  return parts.join(" · ");
}
