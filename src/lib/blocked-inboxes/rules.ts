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
// Those are the defaults. The tiers are edited on the tool's Settings tab and
// stored with its other settings; validateRules is what stands between that
// form and the rules an inbox is deleted on.
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

export interface InboxRules {
  microsoft: Tier[];
  google: Tier[];
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

export const DEFAULT_RULES: InboxRules = { microsoft: MICROSOFT_TIERS, google: GOOGLE_TIERS };

export const JUDGE_WINDOW_DAYS = 14;
export const MAX_TIERS = 8;

const isPct = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100;
const asNum = (v: unknown): number | undefined =>
  v === undefined || v === null || v === "" ? undefined : typeof v === "number" ? v : Number(v);

/**
 * Checks a set of tiers from the Settings form. Each tier starts at a send
 * count (the first at 0) and runs to one below the next; its upper end is
 * worked out, never typed, so there can be no gaps or overlaps. Every problem
 * is named; nothing half-valid is ever saved.
 */
export function validateRules(input: unknown): { rules: InboxRules | null; problems: string[] } {
  const src = (input ?? {}) as Record<string, unknown>;
  const problems: string[] = [];
  const side = (key: "microsoft" | "google", label: string): Tier[] => {
    const raw = Array.isArray(src[key]) ? (src[key] as Record<string, unknown>[]) : [];
    if (raw.length === 0) {
      problems.push(`${label}: add at least one tier.`);
      return [];
    }
    if (raw.length > MAX_TIERS) problems.push(`${label}: at most ${MAX_TIERS} tiers.`);
    const tiers: Tier[] = [];
    raw.forEach((t, i) => {
      const n = i + 1;
      const min = i === 0 ? 0 : asNum(t.min);
      if (min === undefined || !Number.isInteger(min) || min < 0) {
        problems.push(`${label} tier ${n}: "from" must be a whole number of sends.`);
      } else if (i > 0 && tiers[i - 1] && min <= tiers[i - 1].min) {
        problems.push(`${label} tier ${n}: must start above ${tiers[i - 1].min} sends, where the tier before it starts.`);
      }
      const bounce = asNum(t.maxBounceRate);
      if (!isPct(bounce)) problems.push(`${label} tier ${n}: the bounce rate must be a percentage from 0 to 100.`);
      const ooo = asNum(t.minOooReplyRate);
      if (ooo !== undefined && !isPct(ooo)) problems.push(`${label} tier ${n}: the OOO reply rate must be a percentage from 0 to 100, or empty.`);
      const human = asNum(t.humanReplyOverrule);
      if (human !== undefined && !isPct(human)) problems.push(`${label} tier ${n}: the human reply rate must be a percentage from 0 to 100, or empty.`);
      tiers.push({
        min: min ?? 0,
        max: null,
        maxBounceRate: bounce ?? 0,
        ...(ooo !== undefined ? { minOooReplyRate: ooo } : {}),
        ...(human !== undefined ? { humanReplyOverrule: human } : {}),
      });
    });
    for (let i = 0; i < tiers.length - 1; i++) tiers[i].max = tiers[i + 1].min - 1;
    return tiers;
  };
  const rules = { microsoft: side("microsoft", "Microsoft"), google: side("google", "Google") };
  return problems.length > 0 ? { rules: null, problems } : { rules, problems };
}

/** Rules read back from disk: anything unreadable falls back to the defaults, whole. */
export function normalizeRules(input: unknown): InboxRules {
  return validateRules(input).rules ?? DEFAULT_RULES;
}

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

export function tierFor(provider: ProviderBucket, sent: number, rules: InboxRules = DEFAULT_RULES): Tier | undefined {
  const tiers = provider === "google" ? rules.google : provider === "microsoft" ? rules.microsoft : [];
  return tiers.find((t) => sent >= t.min && (t.max === null || sent <= t.max));
}

/** "15–29 sends", "46+ sends", "under 15 sends" */
export function describeTier(t: Tier): string {
  if (t.min === 0 && t.max === null) return "any number of sends";
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

export function judgeInbox(provider: ProviderBucket, f: InboxFigures, rules: InboxRules = DEFAULT_RULES): Judgement {
  const rates = ratesOf(f);
  const tier = tierFor(provider, f.sent, rules);
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
