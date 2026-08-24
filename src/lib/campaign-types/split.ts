// The 4-way lead split.
//
// Microsoft leads all leave the source campaign and are halved across the two
// blue campaigns. Everything else is halved between the source (where it stays
// put) and the Opt Out campaign. With 20,000 leads of which 10,000 are
// Microsoft, all four campaigns end up with 5,000.
//
//   source          keeps  ceil(other / 2)      non-Microsoft
//   optOut          gets   floor(other / 2)     non-Microsoft
//   blue            gets   ceil(ms / 2)         Microsoft
//   blueOptOut      gets   floor(ms / 2)        Microsoft
//
// Odd counts give the extra lead to the non-Opt-Out side, so the source and
// blue campaigns are never the smaller half.

export type Destination = "source" | "optOut" | "blue" | "blueOptOut";

export interface SplitCounts {
  source: number;
  optOut: number;
  blue: number;
  blueOptOut: number;
}

export interface SplitPlan<T> {
  counts: SplitCounts;
  /** Leads to move, keyed by destination. `source` never appears — it stays. */
  moves: { destination: Exclude<Destination, "source">; leads: T[] }[];
}

export function splitCounts(microsoft: number, other: number): SplitCounts {
  const blue = Math.ceil(microsoft / 2);
  const optOut = Math.floor(other / 2);
  return {
    source: other - optOut,
    optOut,
    blue,
    blueOptOut: microsoft - blue,
  };
}

/**
 * Assigns concrete leads to destinations. Order within each bucket is the order
 * given, so callers decide the ordering (we page leads in `_id` order, which is
 * stable across a resumed run).
 */
export function planSplit<T>(microsoft: T[], other: T[]): SplitPlan<T> {
  const counts = splitCounts(microsoft.length, other.length);
  return {
    counts,
    moves: [
      { destination: "blue", leads: microsoft.slice(0, counts.blue) },
      { destination: "blueOptOut", leads: microsoft.slice(counts.blue) },
      { destination: "optOut", leads: other.slice(counts.source) },
    ],
  };
}
