// Judging one sender inbox Clay sent.
//
// The same rule for Microsoft (Azure) and Google. An inbox is removed when:
//
//   1. its OOO reply rate over the last 7 days is 0% — unless people replied
//      to it over the last 14 days (human reply rate above 0%), or
//   2. its OOO reply rate is above that, but its human reply rate over the
//      last 14 days is 0% — and it has been sending for at least 14 days.
//
// So a human reply in the last 14 days always keeps an inbox: a quiet week
// after real replies is not a block.
//
//   Human reply rate   replies ÷ unique leads contacted
//   OOO reply rate     (replies + out-of-office) ÷ unique leads contacted
//
// "Sending for at least 14 days" is read off the inbox's own sends: it had
// campaign sends 14 or more days ago. The date it was added to Plusvibe would
// count its warmup too. An inbox that sent nothing in the last 7 days has no
// OOO reply rate, so it isn't judged. Any other kind of inbox is recorded and
// never touched.
//
// The numbers — both windows, both rates, the 14 days — are the defaults;
// they are edited on the tool's Settings tab, and validateRemovalRule is what
// stands between that form and the rule an inbox is deleted on.
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
  /** Fails the rule: stopped, then deleted (or waiting to be). */
  | "block"
  /** Within the rule, or not judged. Nothing is done. */
  | "pass"
  /** Neither Microsoft nor Google: recorded, never touched. */
  | "untouched";

export interface RemovalRule {
  /** The OOO reply rate is read over this many days, today included. */
  oooDays: number;
  /** Removed when the OOO reply rate is at or under this, in %. */
  maxOooRate: number;
  /** The human reply rate is read over this many days. */
  humanDays: number;
  /** …and removed when the human reply rate is at or under this, in %… */
  maxHumanRate: number;
  /** …once it has been sending for at least this many days. */
  minSendingDays: number;
}

export const DEFAULT_REMOVAL_RULE: RemovalRule = { oooDays: 7, maxOooRate: 0, humanDays: 14, maxHumanRate: 0, minSendingDays: 14 };

/** The window a Microsoft domain's remaining inboxes are judged on when it is cancelled. */
export const JUDGE_WINDOW_DAYS = 14;
export const MAX_WINDOW_DAYS = 90;

const asNum = (v: unknown): number | undefined =>
  v === undefined || v === null || v === "" ? undefined : typeof v === "number" ? v : Number(v);
const isPct = (n: number | undefined): n is number => n !== undefined && Number.isFinite(n) && n >= 0 && n <= 100;
const isDays = (n: number | undefined, min: number): n is number => n !== undefined && Number.isInteger(n) && n >= min && n <= MAX_WINDOW_DAYS;

/** Checks the rule from the Settings form. Every problem is named; nothing half-valid is saved. */
export function validateRemovalRule(input: unknown): { rule: RemovalRule | null; problems: string[] } {
  const src = (input ?? {}) as Record<string, unknown>;
  const problems: string[] = [];
  const oooDays = asNum(src.oooDays);
  const maxOooRate = asNum(src.maxOooRate);
  const humanDays = asNum(src.humanDays);
  const maxHumanRate = asNum(src.maxHumanRate);
  const minSendingDays = asNum(src.minSendingDays);
  if (!isDays(oooDays, 1)) problems.push(`The OOO window must be a whole number of days from 1 to ${MAX_WINDOW_DAYS}.`);
  if (!isPct(maxOooRate)) problems.push("The OOO reply rate must be a percentage from 0 to 100.");
  if (!isDays(humanDays, 1)) problems.push(`The human reply window must be a whole number of days from 1 to ${MAX_WINDOW_DAYS}.`);
  if (!isPct(maxHumanRate)) problems.push("The human reply rate must be a percentage from 0 to 100.");
  if (!isDays(minSendingDays, 0)) problems.push(`How long it has been sending must be a whole number of days from 0 to ${MAX_WINDOW_DAYS}.`);
  if (problems.length > 0) return { rule: null, problems };
  return { rule: { oooDays: oooDays!, maxOooRate: maxOooRate!, humanDays: humanDays!, maxHumanRate: maxHumanRate!, minSendingDays: minSendingDays! }, problems };
}

/** The rule read back from disk: anything unreadable falls back to the defaults, whole. */
export function normalizeRemovalRule(input: unknown): RemovalRule {
  return validateRemovalRule(input).rule ?? DEFAULT_REMOVAL_RULE;
}

const atOrUnder = (rate: number) => (rate === 0 ? "is 0%" : `is ${rate}% or less`);
const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

/** The rule in one sentence: "OOO reply rate over the last 7 days is 0%, or …". */
export function describeRemovalRule(r: RemovalRule): string {
  const age = r.minSendingDays > 0 ? ` and it has been sending for ${days(r.minSendingDays)} or more` : "";
  const humanOk = r.maxHumanRate === 0 ? "above 0%" : `above ${r.maxHumanRate}%`;
  return `OOO reply rate over the last ${days(r.oooDays)} ${atOrUnder(r.maxOooRate)} (unless the human reply rate over the last ${days(r.humanDays)} is ${humanOk}), or it is above that but the human reply rate over the last ${days(r.humanDays)} ${atOrUnder(r.maxHumanRate)}${age}`;
}

export interface JudgeInput {
  /** Over the OOO window. */
  ooo: InboxFigures;
  /** Over the human reply window; null when it couldn't be read. */
  human: InboxFigures | null;
  /** Whether it has been sending long enough; null when that couldn't be told. */
  sendingLongEnough: boolean | null;
}

export interface Judgement {
  verdict: InboxVerdict;
  provider: ProviderBucket;
  /** Over the OOO window. */
  rates: InboxRates;
  /** Over the human reply window, when read. */
  humanRates?: InboxRates;
  /** What failed, in words. Empty on a pass. */
  reasons: string[];
  /** Why an inbox the second rule nearly caught is kept. */
  kept?: string;
  /** Set when it wasn't judged at all. */
  notJudged?: string;
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

export function judgeInbox(provider: ProviderBucket, input: JudgeInput, rule: RemovalRule = DEFAULT_REMOVAL_RULE): Judgement {
  const rates = ratesOf(input.ooo);
  const humanRates = input.human ? ratesOf(input.human) : undefined;
  const base = { provider, rates, ...(humanRates ? { humanRates } : {}) };
  if (provider !== "google" && provider !== "microsoft") return { verdict: "untouched", ...base, reasons: [] };
  if (input.ooo.sent === 0) {
    return { verdict: "pass", ...base, reasons: [], notJudged: `it sent nothing in the last ${days(rule.oooDays)}, so there is no OOO reply rate to judge` };
  }

  // 1. No replies of any kind — unless people replied over the longer human
  // window: a quiet week after real replies isn't a block.
  if (rates.oooReplyRate <= rule.maxOooRate) {
    if (humanRates && humanRates.humanReplyRate > rule.maxHumanRate) {
      return {
        verdict: "pass",
        ...base,
        reasons: [],
        kept: `its OOO reply rate over the last ${days(rule.oooDays)} ${rule.maxOooRate === 0 ? "is 0%" : `is ${rates.oooReplyRate}%`}, but people replied: the human reply rate over the last ${days(rule.humanDays)} is ${humanRates.humanReplyRate}%`,
      };
    }
    return { verdict: "block", ...base, reasons: [`OOO reply rate over the last ${days(rule.oooDays)} ${rule.maxOooRate === 0 ? "is 0%" : `is ${rates.oooReplyRate}%, at or under ${rule.maxOooRate}%`}`] };
  }

  // 2. Out-of-office replies, but no person has answered.
  if (!humanRates) {
    return { verdict: "pass", ...base, reasons: [], kept: `its human reply rate over the last ${days(rule.humanDays)} couldn't be read, so the second rule wasn't checked` };
  }
  if (humanRates.humanReplyRate > rule.maxHumanRate) return { verdict: "pass", ...base, reasons: [] };
  const human = `the human reply rate over the last ${days(rule.humanDays)} ${rule.maxHumanRate === 0 ? "is 0%" : `is ${humanRates.humanReplyRate}%, at or under ${rule.maxHumanRate}%`}`;
  if (rule.minSendingDays > 0 && input.sendingLongEnough !== true) {
    return {
      verdict: "pass",
      ...base,
      reasons: [],
      kept:
        input.sendingLongEnough === false
          ? `${human}, but it hasn't been sending for ${days(rule.minSendingDays)} yet`
          : `${human}, but how long it has been sending couldn't be read, so it wasn't removed on that`,
    };
  }
  const age = rule.minSendingDays > 0 ? ` and it has been sending for ${days(rule.minSendingDays)} or more` : "";
  return { verdict: "block", ...base, reasons: [`OOO reply rate is ${rates.oooReplyRate}%, but ${human}${age}`] };
}
