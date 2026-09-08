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

export function splitCounts(microsoft: number, other: number): SplitCounts {
  const optOut = Math.floor(other / 2);
  const rest = other - optOut;
  const source = Math.ceil(rest / 2);

  const blueOptOut = Math.floor(microsoft / 2);
  const blueRest = microsoft - blueOptOut;
  const blue = Math.ceil(blueRest / 2);

  return {
    source,
    optOut,
    blue,
    blueOptOut,
    signature: rest - source,
    blueSignature: blueRest - blue,
  };
}

/**
 * Assigns concrete leads to destinations. Order within each bucket is the order
 * given, so callers decide the ordering (we page leads in `_id` order, which is
 * stable across a resumed run).
 */
export function planSplit<T>(microsoft: T[], other: T[]): SplitPlan<T> {
  const counts = splitCounts(microsoft.length, other.length);
  const otherSignatureEnd = counts.source + counts.signature;
  const blueSignatureEnd = counts.blue + counts.blueSignature;
  return {
    counts,
    moves: [
      { destination: "blue", leads: microsoft.slice(0, counts.blue) },
      {
        destination: "blueSignature",
        leads: microsoft.slice(counts.blue, blueSignatureEnd),
      },
      { destination: "blueOptOut", leads: microsoft.slice(blueSignatureEnd) },
      {
        destination: "signature",
        leads: other.slice(counts.source, otherSignatureEnd),
      },
      { destination: "optOut", leads: other.slice(otherSignatureEnd) },
    ],
  };
}
