// The 6-way lead split.
//
// Each provider bucket is divided the same way, in two stages. The Opt Out
// campaign takes half of the bucket first, exactly as it did when this tool
// made four campaigns. What is left over then halves again between the
// campaign it was sitting in and its Signature copy.
//
//   other (non-Microsoft)            microsoft
//   ─────────────────────            ─────────────────────
//   optOut     floor(other / 2)      blueOptOut     floor(ms / 2)
//   source     ceil(rest / 2)        blue           ceil(blueRest / 2)
//   signature  rest - source         blueSignature  blueRest - blue
//
// With 20,000 leads of which 10,000 are Microsoft: 5,000 to each Opt Out
// campaign, and 2,500 each to the source, blue, Signature and 🔵 Signature.
//
// Odd counts give the extra lead to the non-Opt-Out side, and then to the
// non-Signature side, so the source and blue campaigns are never the smaller
// half at either stage.
//
// A Move run takes the campaigns as it finds them, so a stage whose campaign
// is missing simply doesn't happen: its share stays with the others in the
// same provider bucket. Microsoft leads with no 🔵 campaign at all stay in the
// source rather than going somewhere they don't belong.

export type Destination =
  | "source"
  | "optOut"
  | "blue"
  | "blueOptOut"
  | "signature"
  | "blueSignature";

export interface SplitCounts {
  source: number;
  optOut: number;
  blue: number;
  blueOptOut: number;
  signature: number;
  blueSignature: number;
}

export interface SplitPlan<T> {
  counts: SplitCounts;
  /** Leads to move, keyed by destination. `source` never appears — it stays. */
  moves: { destination: Exclude<Destination, "source">; leads: T[] }[];
}

/**
 * Which of the five copies a run can actually put leads into.
 *
 * A Create run always has all five, since it just made them. A Move run takes
 * the campaigns as it finds them, and one that isn't there simply isn't a
 * destination.
 */
export interface Availability {
  blue: boolean;
  blueOptOut: boolean;
  blueSignature: boolean;
  optOut: boolean;
  signature: boolean;
}

export const ALL_AVAILABLE: Availability = {
  blue: true,
  blueOptOut: true,
  blueSignature: true,
  optOut: true,
  signature: true,
};

/**
 * One provider bucket, divided between the copies that exist.
 *
 * The two stages are the ones described above, and each only happens if it has
 * somewhere to go. So a missing Signature copy means the remainder is not
 * halved a second time and stays in the campaign it was in, and a missing Opt
 * Out copy means the bucket is never halved at all. A bucket with nowhere to
 * go is stranded: those leads stay in the source campaign.
 */
function divide(
  n: number,
  avail: { optOut: boolean; base: boolean; signature: boolean }
): { optOut: number; base: number; signature: number; stranded: number } {
  let optOut = avail.optOut ? Math.floor(n / 2) : 0;
  const rest = n - optOut;
  let base = 0;
  let signature = 0;
  let stranded = 0;
  if (avail.base && avail.signature) {
    base = Math.ceil(rest / 2);
    signature = rest - base;
  } else if (avail.base) {
    base = rest;
  } else if (avail.signature) {
    signature = rest;
  } else if (avail.optOut) {
    optOut += rest;
  } else {
    stranded = rest;
  }
  return { optOut, base, signature, stranded };
}

export function splitCountsFor(
  microsoft: number,
  other: number,
  avail: Availability = ALL_AVAILABLE
): SplitCounts {
  const ms = divide(microsoft, {
    optOut: avail.blueOptOut,
    base: avail.blue,
    signature: avail.blueSignature,
  });
  // The source itself is always a destination for the non-Microsoft bucket —
  // the leads are already in it.
  const ot = divide(other, {
    optOut: avail.optOut,
    base: true,
    signature: avail.signature,
  });
  return {
    // Microsoft leads with no 🔵 campaign to go to stay where they are, which
    // is the source.
    source: ot.base + ms.stranded,
    optOut: ot.optOut,
    blue: ms.base,
    blueOptOut: ms.optOut,
    signature: ot.signature,
    blueSignature: ms.signature,
  };
}

export function splitCounts(microsoft: number, other: number): SplitCounts {
  return splitCountsFor(microsoft, other, ALL_AVAILABLE);
}

/** Leads a copy already received, from an earlier run that was cut off. */
export type Carried = Partial<Record<Exclude<Destination, "source">, number>>;

/**
 * Assigns concrete leads to destinations. Order within each bucket is the order
 * given, so callers decide the ordering (we page leads in `_id` order, which is
 * stable across a resumed run).
 *
 * `carried` is what an interrupted run already moved. Those leads are no longer
 * in the source, so a plain re-run would split only what is left — and the
 * copy that was being filled when the run stopped would end up with its first
 * share plus a fresh share of the rest. Instead the split is worked out on the
 * whole, as the first run saw it, and each copy is given only what it is still
 * short of. With nothing carried this is exactly the plain split.
 */
export function planSplitFor<T>(
  microsoft: T[],
  other: T[],
  avail: Availability = ALL_AVAILABLE,
  carried: Carried = {}
): SplitPlan<T> {
  const had = (d: Exclude<Destination, "source">) => Math.max(0, Math.floor(carried[d] ?? 0));
  const whole = splitCountsFor(
    microsoft.length + had("blue") + had("blueSignature") + had("blueOptOut"),
    other.length + had("signature") + had("optOut"),
    avail
  );

  const moves: SplitPlan<T>["moves"] = [];
  const counts: SplitCounts = { source: 0, optOut: 0, blue: 0, blueOptOut: 0, signature: 0, blueSignature: 0 };
  let at = 0;
  for (const d of ["blue", "blueSignature", "blueOptOut"] as const) {
    const n = Math.min(Math.max(0, whole[d] - had(d)), microsoft.length - at);
    moves.push({ destination: d, leads: microsoft.slice(at, at + n) });
    counts[d] = n;
    at += n;
  }
  // Only a resumed run can get here: a copy credited with more than its share
  // leaves Microsoft leads over. They belong on the 🔵 side, not in the source.
  if (at < microsoft.length && avail.blue) {
    const blue = moves[0];
    blue.leads = blue.leads.concat(microsoft.slice(at));
    counts.blue += microsoft.length - at;
    at = microsoft.length;
  }
  // Anything left of the Microsoft bucket had no 🔵 campaign to go to. It is
  // counted in `source` and simply not moved.
  const strandedMicrosoft = microsoft.length - at;

  // The non-Microsoft bucket leads with the share that stays put, so the
  // ordering is the same one a full run uses.
  const signature = Math.min(Math.max(0, whole.signature - had("signature")), other.length);
  const optOut = Math.min(Math.max(0, whole.optOut - had("optOut")), other.length - signature);
  let from = other.length - signature - optOut;
  counts.source = from + strandedMicrosoft;
  for (const [d, n] of [["signature", signature], ["optOut", optOut]] as const) {
    moves.push({ destination: d, leads: other.slice(from, from + n) });
    counts[d] = n;
    from += n;
  }
  return { counts, moves };
}

export function planSplit<T>(microsoft: T[], other: T[]): SplitPlan<T> {
  return planSplitFor(microsoft, other, ALL_AVAILABLE);
}
