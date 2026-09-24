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

const { judgeInbox, ratesOf, tierFor, describeTier, describeRule } = await importTs("@/lib/blocked-inboxes/rules");

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

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
