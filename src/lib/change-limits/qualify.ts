// Which inboxes count as best performing.
//
// The rate compared here is ALWAYS replies ÷ unique leads contacted, computed
// from the counts by the shared metrics module. Plusvibe's own reply_rate
// divides by emails sent, which reads several times lower once follow-ups are
// in play, and is never used.
//
// Google and Microsoft get their own threshold because they behave differently
// on the same copy. Anything else — an SMTP mailbox, say — is skipped unless a
// threshold is set for it too, so nothing is quietly swept in or dropped.
//
// Pure module — no API, no clock — so all of it is unit-tested.

import type { ProviderBucket } from "@/lib/plusvibe-providers";

export type { ProviderBucket };

/** The form's raw strings, exactly as typed. */
export interface ThresholdsInput {
  google: string;
  microsoft: string;
  /** Blank means: leave other providers out of it. */
  other: string;
  minSends: string;
}

export const DEFAULT_THRESHOLDS: ThresholdsInput = {
  google: "3",
  microsoft: "3",
  other: "",
  minSends: "100",
};

export interface ParsedThresholds {
  google: number;
  microsoft: number;
  /** null when other providers are being skipped. */
  other: number | null;
  minSends: number;
  problems: string[];
  ok: boolean;
}

const MAX_RATE = 100;
const MAX_SENDS = 10_000_000;

export function parseThresholds(input: ThresholdsInput): ParsedThresholds {
  const problems: string[] = [];

  const rate = (raw: string, label: string, required: boolean): number | null => {
    const t = (raw ?? "").trim();
    if (t === "") {
      if (required) problems.push(`Set a true reply rate for ${label}.`);
      return null;
    }
    const n = Number(t);
    if (!Number.isFinite(n)) {
      problems.push(`The ${label} reply rate must be a number.`);
      return null;
    }
    if (n < 0 || n > MAX_RATE) {
      problems.push(`The ${label} reply rate must be between 0 and ${MAX_RATE}%.`);
      return null;
    }
    return n;
  };

  const google = rate(input.google, "Google", true);
  const microsoft = rate(input.microsoft, "Microsoft", true);
  const other = rate(input.other, "other providers", false);

  const sendsRaw = (input.minSends ?? "").trim();
  let minSends = 0;
  if (sendsRaw === "") {
    problems.push("Set a minimum number of sends.");
  } else {
    const n = Number(sendsRaw);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      problems.push("Minimum sends must be a whole number.");
    } else if (n < 0 || n > MAX_SENDS) {
      problems.push(`Minimum sends must be between 0 and ${MAX_SENDS}.`);
    } else {
      minSends = n;
    }
  }

  return {
    google: google ?? 0,
    microsoft: microsoft ?? 0,
    other,
    minSends,
    problems,
    ok: problems.length === 0,
  };
}

/** The threshold an inbox is measured against, or null if it is skipped. */
export function thresholdFor(
  provider: ProviderBucket,
  t: ParsedThresholds
): number | null {
  if (provider === "google") return t.google;
  if (provider === "microsoft") return t.microsoft;
  return t.other;
}

export type Verdict =
  /** Meets its provider's reply rate and has sent enough. */
  | "qualifies"
  | "below-rate"
  | "too-few-sends"
  /** Neither Google nor Microsoft, and no threshold was set for the rest. */
  | "provider-skipped"
  /** Stats could not be read, so there is nothing to judge it on. */
  | "no-stats";

export const VERDICT_LABELS: Record<Verdict, string> = {
  qualifies: "Qualifies",
  "below-rate": "Below reply rate",
  "too-few-sends": "Too few sends",
  "provider-skipped": "Provider skipped",
  "no-stats": "No stats",
};

export interface Candidate {
  provider: ProviderBucket;
  /** True when the inbox's stats were read; false while pending or on error. */
  loaded: boolean;
  sent: number;
  /** replies ÷ unique contacted, as a percentage. */
  replyRate: number;
}

export interface Judgement {
  verdict: Verdict;
  /** What it was measured against, when it was measured at all. */
  threshold: number | null;
}

/**
 * Judges one inbox. Order matters: an inbox with no stats is never called
 * "below rate", and one whose provider is skipped is never judged on a
 * threshold it was never given.
 */
export function judge(c: Candidate, t: ParsedThresholds): Judgement {
  const threshold = thresholdFor(c.provider, t);
  if (threshold === null) return { verdict: "provider-skipped", threshold: null };
  if (!c.loaded) return { verdict: "no-stats", threshold };
  if (c.sent < t.minSends) return { verdict: "too-few-sends", threshold };
  // At the threshold counts as meeting it.
  if (c.replyRate < threshold) return { verdict: "below-rate", threshold };
  return { verdict: "qualifies", threshold };
}

export type VerdictCounts = Record<Verdict, number>;

export function emptyCounts(): VerdictCounts {
  return {
    qualifies: 0,
    "below-rate": 0,
    "too-few-sends": 0,
    "provider-skipped": 0,
    "no-stats": 0,
  };
}

export function countVerdicts(verdicts: Verdict[]): VerdictCounts {
  const counts = emptyCounts();
  for (const v of verdicts) counts[v] += 1;
  return counts;
}

/** Why the inboxes that did not qualify were left out, most common first. */
export function describeSkipped(counts: VerdictCounts): string {
  const parts: [Verdict, number][] = (
    Object.entries(counts) as [Verdict, number][]
  ).filter(([v, n]) => v !== "qualifies" && n > 0);
  parts.sort((a, b) => b[1] - a[1]);
  return parts.map(([v, n]) => `${n} ${VERDICT_LABELS[v].toLowerCase()}`).join(", ");
}
