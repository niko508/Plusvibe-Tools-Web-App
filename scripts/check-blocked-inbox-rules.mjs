// Unit checks for judging one sender inbox on its last 14 days: every tier's
// edges, both providers, the Google overrule, and the rates themselves.
// Imports the REAL module.
//
//   node scripts/check-blocked-inbox-rules.mjs

import { importTs } from "./ts-loader.mjs";

let failures = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`PASS  ${label}`);
  else {
    failures++;
    console.log(`FAIL  ${label}\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`);
  }
};

const { judgeInbox, ratesOf, tierFor, describeTier, describeRule, validateRules, normalizeRules, DEFAULT_RULES } = await importTs("@/lib/blocked-inboxes/rules");

// An inbox that sent `sent`, with `bounces` bounced, `contacted` unique leads,
// `replies` human replies and `ooo` out-of-office replies.
const f = (sent, bounces, contacted = sent, replies = 0, ooo = 0) => ({ sent, bounces, contacted, replies, oooReplies: ooo });
const v = (provider, figures) => judgeInbox(provider, figures).verdict;

console.log("--- the rates");
eq("bounce rate is over everything sent", ratesOf(f(40, 10, 20)).bounceRate, 25);
eq("reply rates are over unique leads contacted", [ratesOf(f(40, 0, 20, 1, 1)).humanReplyRate, ratesOf(f(40, 0, 20, 1, 1)).oooReplyRate], [5, 10]);
eq("no contacted count falls back to sends, not to 0%", ratesOf(f(50, 0, 0, 1, 0)).humanReplyRate, 2);
eq("nothing sent is 0%, not a division by zero", ratesOf(f(0, 0, 0)), { bounceRate: 0, humanReplyRate: 0, oooReplyRate: 0 });

console.log("--- the tiers each send count falls in");
const tierOf = (p, n) => describeTier(tierFor(p, n));
eq("Microsoft: 0, 14 | 15, 29 | 30, 45 | 46, 500",
  [0, 14, 15, 29, 30, 45, 46, 500].map((n) => tierOf("microsoft", n)),
  ["under 15 sends", "under 15 sends", "15–29 sends", "15–29 sends", "30–45 sends", "30–45 sends", "46+ sends", "46+ sends"]);
eq("Google: 0, 14 | 15, 49 | 50, 100 | 101, 900",
  [0, 14, 15, 49, 50, 100, 101, 900].map((n) => tierOf("google", n)),
  ["under 15 sends", "under 15 sends", "15–49 sends", "15–49 sends", "50–100 sends", "50–100 sends", "101+ sends", "101+ sends"]);
eq("other inboxes have no tier", tierFor("other", 60), undefined);

console.log("--- Microsoft");
eq("under 15: blocked only over 75% bounce", [v("microsoft", f(10, 7)), v("microsoft", f(10, 8)), v("microsoft", f(4, 3)), v("microsoft", f(4, 4))], ["pass", "block", "pass", "block"]);
eq("15–29: over 50%", [v("microsoft", f(20, 10)), v("microsoft", f(20, 11))], ["pass", "block"]);
eq("30–45: over 25%", [v("microsoft", f(40, 10)), v("microsoft", f(40, 11))], ["pass", "block"]);
eq("30–45: a low reply rate alone does not block", v("microsoft", f(40, 0, 40, 0, 0)), "pass");
eq("46+: over 10% bounce blocks", [v("microsoft", f(100, 10, 100, 5)), v("microsoft", f(100, 11, 100, 5))], ["pass", "block"]);
eq("46+: OOO reply rate under 1.5% blocks", [v("microsoft", f(200, 0, 200, 3, 0)), v("microsoft", f(200, 0, 200, 2, 0))], ["pass", "block"]);
eq("46+: OOO replies count towards it", v("microsoft", f(200, 0, 200, 1, 2)), "pass");
eq("Microsoft has no human-reply overrule", v("microsoft", f(100, 20, 100, 10, 0)), "block");
{
  const j = judgeInbox("microsoft", f(100, 20, 100, 1, 0));
  eq("…and says every reason", j.reasons, ["bounce rate 20% is over 10%", "OOO reply rate 1% is under 1.5%"]);
}

console.log("--- Google");
eq("under 15: over 75%", [v("google", f(8, 6)), v("google", f(8, 7))], ["pass", "block"]);
eq("15–49: over 50%, and nothing else", [v("google", f(40, 20)), v("google", f(40, 21)), v("google", f(40, 0, 40, 0, 0))], ["pass", "block", "pass"]);
eq("50–100: over 10% bounce", [v("google", f(100, 10, 100, 3)), v("google", f(100, 11, 100, 0, 3))], ["pass", "block"]);
eq("50–100: OOO under 2%", [v("google", f(100, 0, 100, 1, 1)), v("google", f(100, 0, 100, 0, 1))], ["pass", "block"]);
eq("101+: over 5% bounce", [v("google", f(200, 10, 200, 0, 4)), v("google", f(200, 11, 200, 0, 4))], ["pass", "block"]);
eq("101+: OOO under 2%", v("google", f(200, 0, 200, 0, 3)), "block");
{
  // Bounce 15% and OOO 1.5% would both block — but people answer it.
  const j = judgeInbox("google", f(200, 30, 200, 3, 0));
  eq("a human reply rate over 1% overrules on 50+", [j.verdict, j.reasons.length > 0], ["pass", false]);
  eq("…and says why", j.overruled, "human reply rate 1.5% is over 1%, which overrules bounce rate 15% is over 5% and OOO reply rate 1.5% is under 2%");
}
eq("exactly 1% human does not overrule", v("google", f(100, 20, 100, 1, 0)), "block");
eq("the overrule does not reach the 15–49 tier", v("google", f(40, 30, 40, 10, 0)), "block");

console.log("--- anything else");
eq("an inbox that is neither Microsoft nor Google is untouched", [v("other", f(100, 100)), judgeInbox("other", f(100, 100)).reasons], ["untouched", []]);

console.log("--- in words");
eq("rules read the way they were given", [
  describeRule(tierFor("microsoft", 46)),
  describeRule(tierFor("google", 101)),
], ["bounce > 10% or OOO reply rate < 1.5%", "bounce > 5% or OOO reply rate < 2% · human reply rate > 1% overrules"]);

console.log("--- rules edited on the Settings tab");
{
  // As the form sends them: numbers as text, empty boxes left out.
  const form = {
    microsoft: [{ min: "0", maxBounceRate: "80" }, { min: "20", maxBounceRate: "40" }, { min: "60", maxBounceRate: "8", minOooReplyRate: "1" }],
    google: [{ min: "0", maxBounceRate: "75" }, { min: "40", maxBounceRate: "10", minOooReplyRate: "2", humanReplyOverrule: "1.5" }],
  };
  const { rules, problems } = validateRules(form);
  eq("a sound set is accepted", problems, []);
  eq("…each tier running to one below the next", rules.microsoft.map((t) => [t.min, t.max]), [[0, 19], [20, 59], [60, null]]);
  eq("…with an empty box meaning not checked", [rules.microsoft[0].minOooReplyRate, rules.google[1].humanReplyOverrule], [undefined, 1.5]);
  eq("judging uses them", [judgeInbox("microsoft", f(30, 13), rules).verdict, judgeInbox("microsoft", f(30, 12), rules).verdict], ["block", "pass"]);
  eq("…where the defaults would say otherwise", [judgeInbox("microsoft", f(30, 8), rules).verdict, judgeInbox("microsoft", f(30, 8)).verdict], ["pass", "block"]);
  eq("…the overrule too", judgeInbox("google", f(100, 20, 100, 2), rules).verdict, "pass");
  eq("…and the tier reads back", [describeTier(rules.microsoft[1]), describeRule(rules.google[1])], ["20–59 sends", "bounce > 10% or OOO reply rate < 2% · human reply rate > 1.5% overrules"]);
}
eq("the first tier can start above 0", validateRules({ microsoft: [{ min: "5", maxBounceRate: 50 }], google: [{ min: 0, maxBounceRate: 50 }] }).rules.microsoft[0].min, 5);
eq("…and an empty start is 0", validateRules({ microsoft: [{ min: "", maxBounceRate: 50 }], google: [{ min: 0, maxBounceRate: 50 }] }).rules.microsoft[0].min, 0);
{
  const rules = validateRules({ microsoft: [{ min: 5, maxBounceRate: 50 }], google: [{ min: 0, maxBounceRate: 50 }] }).rules;
  const j = judgeInbox("microsoft", { sent: 4, bounces: 4, contacted: 4, replies: 0, oooReplies: 0 }, rules);
  eq("below the first tier an inbox isn't judged, whatever it bounced", [j.verdict, j.tier, j.notJudged], ["pass", undefined, "4 sends is under the 5 the first tier starts at, so it isn't judged"]);
  eq("…at the first tier it is", judgeInbox("microsoft", { sent: 5, bounces: 5, contacted: 5, replies: 0, oooReplies: 0 }, rules).verdict, "block");
}
eq("tiers out of order are refused, named",
  validateRules({ microsoft: [{ min: 0, maxBounceRate: 50 }, { min: 30, maxBounceRate: 20 }, { min: 30, maxBounceRate: 10 }], google: [{ min: 0, maxBounceRate: 50 }] }).problems,
  ["Microsoft tier 3: must start above 30 sends, where the tier before it starts."]);
eq("…so is a percentage over 100, or not a number",
  validateRules({ microsoft: [{ min: 0, maxBounceRate: 150 }], google: [{ min: 0, maxBounceRate: "x" }] }).problems,
  ["Microsoft tier 1: the bounce rate must be a percentage from 0 to 100.", "Google tier 1: the bounce rate must be a percentage from 0 to 100."]);
eq("…and a provider with no tiers", validateRules({ microsoft: [], google: [{ min: 0, maxBounceRate: 50 }] }).problems, ["Microsoft: add at least one tier."]);
eq("nothing is saved while anything is wrong", validateRules({ microsoft: [], google: [] }).rules, null);
eq("the defaults validate as they are", JSON.stringify(validateRules(DEFAULT_RULES).rules), JSON.stringify(DEFAULT_RULES));
eq("a stored set that doesn't read falls back to the defaults, whole", JSON.stringify(normalizeRules({ microsoft: "junk" })), JSON.stringify(DEFAULT_RULES));

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
