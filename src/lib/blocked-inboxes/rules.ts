// Judging one sender inbox on its last 14 days.
//
// Blocked Domains used to act on whole domains, and a flagged domain turned
// out not to mean much: plenty kept replying. So the automation now takes the
// one inbox Clay saw bouncing, reads that inbox's own last 14 days, and blocks
// it only if its own figures say so.
//
// The bar depends on how much the inbox has sent: a handful of sends proves
// little, so a small sender is blocked only when nearly everything bounced,
// and the bar tightens as the volume grows.
//
//   Bounce rate        bounces ÷ everything sent
//   Human reply rate   replies ÷ unique leads contacted
//   OOO reply rate     (replies + out-of-office) ÷ unique leads contacted
//
// Microsoft (Azure)            Google
//   under 15   bounce > 75%      under 15   bounce > 75%
//   15–29      bounce > 50%      15–49      bounce > 50%
//   30–45      bounce > 25%      50–100     bounce > 10% or OOO < 2%
//   46+        bounce > 10%      101+       bounce > 5%  or OOO < 2%
//              or OOO < 1.5%
//
// For Google on the two top tiers, a human reply rate above 1% overrules: an
// inbox people are actually answering stays, whatever else its figures say.
// Any other kind of inbox is recorded and never touched.
//
// Pure module — no API — so all of it is unit-tested.

import type { ProviderBucket } from "@/lib/plusvibe-providers";

export interface InboxFigures {
  sent: number;
  bounces: number;
  /** Unique leads contacted: the denominator of both reply rates. */
  contacted: number;
  /** Replies from people, not counting out-of-office. */
  replies: number;
  oooReplies: number;
}

export interface InboxRates {
  /** Percentages: 7.5 means 7.5%. */
  bounceRate: number;
  humanReplyRate: number;
  oooReplyRate: number;
}

export type InboxVerdict =
  /** Fails its tier: stopped, then deleted (or waiting to be). */
  | "block"
  /** Within its tier. Nothing is done. */
  | "pass"
  /** Neither Microsoft nor Google: recorded, never touched. */
  | "untouched";

export interface Tier {
  /** Inclusive send range. `max` null means no upper end. */
  min: number;
  max: number | null;
  /** Blocked when the bounce rate is ABOVE this. */
  maxBounceRate: number;
  /** Blocked when the OOO reply rate is BELOW this. Absent: not checked. */
  minOooReplyRate?: number;
  /** Not blocked, whatever else, when the human reply rate is ABOVE this. */
  humanReplyOverrule?: number;
}

export const MICROSOFT_TIERS: Tier[] = [
  { min: 0, max: 14, maxBounceRate: 75 },
  { min: 15, max: 29, maxBounceRate: 50 },
  { min: 30, max: 45, maxBounceRate: 25 },
  { min: 46, max: null, maxBounceRate: 10, minOooReplyRate: 1.5 },
];

export const GOOGLE_TIERS: Tier[] = [
  { min: 0, max: 14, maxBounceRate: 75 },
  { min: 15, max: 49, maxBounceRate: 50 },
  { min: 50, max: 100, maxBounceRate: 10, minOooReplyRate: 2, humanReplyOverrule: 1 },
  { min: 101, max: null, maxBounceRate: 5, minOooReplyRate: 2, humanReplyOverrule: 1 },
];

export const JUDGE_WINDOW_DAYS = 14;

export interface Judgement {
  verdict: InboxVerdict;
  provider: ProviderBucket;
  rates: InboxRates;
  /** The tier the inbox was judged on; absent when untouched. */
  tier?: Tier;
  /** What failed, in words: "bounce rate 62% is over 50%". Empty on a pass. */
  reasons: string[];
  /** Set when the human reply rate kept an inbox that would otherwise be blocked. */
  overruled?: string;
}

const round = (n: number) => Math.round(n * 100) / 100;
const pct = (part: number, whole: number) => (whole > 0 ? round((part / whole) * 100) : 0);

export function ratesOf(f: InboxFigures): InboxRates {
  // Unique leads contacted is the denominator the rest of the app uses for
  // reply rates. An inbox that sent but reports no contacted count falls
  // back to its sends, so an empty field doesn't read as a 0% reply rate.
  const base = f.contacted > 0 ? f.contacted : f.sent;
  return {
    bounceRate: pct(f.bounces, f.sent),
    humanReplyRate: pct(f.replies, base),
    oooReplyRate: pct(f.replies + f.oooReplies, base),
  };
}

export function tierFor(provider: ProviderBucket, sent: number): Tier | undefined {
  const tiers = provider === "google" ? GOOGLE_TIERS : provider === "microsoft" ? MICROSOFT_TIERS : [];
  return tiers.find((t) => sent >= t.min && (t.max === null || sent <= t.max));
}

/** "15–29 sends", "46+ sends", "under 15 sends" */
export function describeTier(t: Tier): string {
  if (t.min === 0 && t.max !== null) return `under ${t.max + 1} sends`;
  if (t.max === null) return `${t.min}+ sends`;
  return `${t.min}–${t.max} sends`;
}

/** "bounce > 10% or OOO reply rate < 2% · human reply rate > 1% overrules" */
export function describeRule(t: Tier): string {
  const parts = [`bounce > ${t.maxBounceRate}%`];
  if (t.minOooReplyRate !== undefined) parts.push(`OOO reply rate < ${t.minOooReplyRate}%`);
  const rule = parts.join(" or ");
  return t.humanReplyOverrule !== undefined ? `${rule} · human reply rate > ${t.humanReplyOverrule}% overrules` : rule;
}

export function judgeInbox(provider: ProviderBucket, f: InboxFigures): Judgement {
  const rates = ratesOf(f);
  const tier = tierFor(provider, f.sent);
  if (!tier) return { verdict: "untouched", provider, rates, reasons: [] };

  const reasons: string[] = [];
  if (rates.bounceRate > tier.maxBounceRate) {
    reasons.push(`bounce rate ${rates.bounceRate}% is over ${tier.maxBounceRate}%`);
  }
  if (tier.minOooReplyRate !== undefined && rates.oooReplyRate < tier.minOooReplyRate) {
    reasons.push(`OOO reply rate ${rates.oooReplyRate}% is under ${tier.minOooReplyRate}%`);
  }
  if (reasons.length === 0) return { verdict: "pass", provider, rates, tier, reasons };

  if (tier.humanReplyOverrule !== undefined && rates.humanReplyRate > tier.humanReplyOverrule) {
    return {
      verdict: "pass",
      provider,
      rates,
      tier,
      reasons: [],
      overruled: `human reply rate ${rates.humanReplyRate}% is over ${tier.humanReplyOverrule}%, which overrules ${reasons.join(" and ")}`,
    };
  }
  return { verdict: "block", provider, rates, tier, reasons };
}
