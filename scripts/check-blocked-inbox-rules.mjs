// Unit checks for judging one sender inbox: the OOO rule, the human reply
// rule and its "sending long enough" condition, both providers alike, what
// isn't judged, the rule's validation, and the rates themselves.
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

const { judgeInbox, ratesOf, validateRemovalRule, normalizeRemovalRule, describeRemovalRule, DEFAULT_REMOVAL_RULE } = await importTs("@/lib/blocked-inboxes/rules");

// An inbox that sent `sent`, with `contacted` unique leads, `replies` human
// replies and `ooo` out-of-office replies.
const f = (sent, contacted = sent, replies = 0, ooo = 0, bounces = 0) => ({ sent, bounces, contacted, replies, oooReplies: ooo });
const judge = (provider, ooo, human = ooo, sendingLongEnough = true, rule) => judgeInbox(provider, { ooo, human, sendingLongEnough }, rule);
const v = (...a) => judge(...a).verdict;

console.log("--- the rates");
eq("bounce rate is over everything sent", ratesOf(f(40, 20, 0, 0, 10)).bounceRate, 25);
eq("reply rates are over unique leads contacted; OOO counts people's replies too", [ratesOf(f(40, 20, 1, 1)).humanReplyRate, ratesOf(f(40, 20, 1, 1)).oooReplyRate], [5, 10]);
eq("no contacted count falls back to sends, not to 0%", ratesOf(f(50, 0, 1, 0)).humanReplyRate, 2);
eq("nothing sent is 0%, not a division by zero", ratesOf(f(0, 0)), { bounceRate: 0, humanReplyRate: 0, oooReplyRate: 0 });

console.log("--- the defaults");
eq("OOO over 7 days at 0%; human over 14 days at 0%; sending 14+ days", DEFAULT_REMOVAL_RULE, { oooDays: 7, maxOooRate: 0, humanDays: 14, maxHumanRate: 0, minSendingDays: 14 });

console.log("--- 1. no replies at all over 7 days");
eq("Microsoft and Google alike: 0% OOO is removed", [v("microsoft", f(40)), v("google", f(40))], ["block", "block"]);
eq("…however few it sent: no minimum", v("microsoft", f(1)), "block");
eq("…however new it is", v("google", f(30), f(30), false), "block");
eq("…in words", judge("microsoft", f(40)).reasons, ["OOO reply rate over the last 7 days is 0%"]);
eq("one out-of-office reply is enough to pass the first rule", v("microsoft", f(40, 40, 0, 1), f(80, 80, 1, 2)), "pass");
eq("nothing sent in the 7 days: not judged, kept", (({ verdict, notJudged }) => [verdict, notJudged])(judge("microsoft", f(0), f(30))), ["pass", "it sent nothing in the last 7 days, so there is no OOO reply rate to judge"]);
eq("neither Microsoft nor Google: never touched", v("other", f(40)), "untouched");

console.log("--- 2. out-of-office replies, but no human ones over 14 days");
const oooOnly = f(40, 40, 0, 2);
eq("no human reply in 14 days and sending 14+ days: removed", v("google", oooOnly, f(90, 90, 0, 3), true), "block");
eq("…in words", judge("google", oooOnly, f(90, 90, 0, 3), true).reasons, ["OOO reply rate is 5%, but the human reply rate over the last 14 days is 0% and it has been sending for 14 days or more"]);
eq("one human reply in the 14 days keeps it", v("microsoft", oooOnly, f(90, 90, 1, 3), true), "pass");
const young = judge("microsoft", oooOnly, f(60, 60, 0, 3), false);
eq("not sending 14 days yet: kept, and says why", [young.verdict, young.kept], ["pass", "the human reply rate over the last 14 days is 0%, but it hasn't been sending for 14 days yet"]);
const unknownAge = judge("microsoft", oooOnly, f(60, 60, 0, 3), null);
eq("how long it has been sending couldn't be read: kept", [unknownAge.verdict, /couldn't be read/.test(unknownAge.kept)], ["pass", true]);
const noHuman = judgeInbox("microsoft", { ooo: oooOnly, human: null, sendingLongEnough: true });
eq("the 14 days couldn't be read: kept", [noHuman.verdict, /couldn't be read/.test(noHuman.kept)], ["pass", true]);
eq("the 14-day rates are reported beside the 7-day ones", judge("google", oooOnly, f(100, 80, 0, 4), true).humanRates, { bounceRate: 0, humanReplyRate: 0, oooReplyRate: 5 });

console.log("--- the rule as edited");
const loose = { oooDays: 7, maxOooRate: 1, humanDays: 14, maxHumanRate: 0.5, minSendingDays: 0 };
eq("a higher OOO bar removes at or under it", [v("microsoft", f(100, 100, 0, 1), f(100, 100, 1, 1), true, loose), v("microsoft", f(100, 100, 0, 2), f(200, 200, 2, 2), true, loose)], ["block", "pass"]);
eq("…and says the rate", judge("microsoft", f(100, 100, 0, 1), f(100, 100, 1, 1), true, loose).reasons, ["OOO reply rate over the last 7 days is 1%, at or under 1%"]);
eq("0 days of sending needed: age not checked", v("google", f(100, 100, 0, 3), f(200, 200, 0, 5), false, loose), "block");
eq("the rule in one sentence", describeRemovalRule(DEFAULT_REMOVAL_RULE),
  "OOO reply rate over the last 7 days is 0%, or it is above that but the human reply rate over the last 14 days is 0% and it has been sending for 14 days or more");

console.log("--- validation");
eq("the defaults, as typed, are valid", validateRemovalRule({ oooDays: "7", maxOooRate: "0", humanDays: "14", maxHumanRate: "0", minSendingDays: "14" }).rule, DEFAULT_REMOVAL_RULE);
eq("every problem named, nothing half-saved", validateRemovalRule({ oooDays: 0, maxOooRate: 101, humanDays: 2.5, maxHumanRate: "", minSendingDays: -1 }), {
  rule: null,
  problems: [
    "The OOO window must be a whole number of days from 1 to 90.",
    "The OOO reply rate must be a percentage from 0 to 100.",
    "The human reply window must be a whole number of days from 1 to 90.",
    "The human reply rate must be a percentage from 0 to 100.",
    "How long it has been sending must be a whole number of days from 0 to 90.",
  ],
});
eq("unreadable on disk: the defaults, whole", [normalizeRemovalRule(undefined), normalizeRemovalRule({ oooDays: 3 })], [DEFAULT_REMOVAL_RULE, DEFAULT_REMOVAL_RULE]);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
