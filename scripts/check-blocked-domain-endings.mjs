// Unit checks for when a blocked inbox ends its domain: the last Google
// inbox, the Microsoft cancellation threshold, and which inboxes a
// cancellation keeps. Imports the REAL module.
//
//   node scripts/check-blocked-domain-endings.mjs

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

const { isLastOnDomain, shouldCancel, planCancellation } = await importTs("@/lib/blocked-inboxes/domain-endings");

console.log("--- the last Google inbox");
const onDomain = ["a@g.com", "b@g.com", "c@g.com"];
eq("not while another inbox is still going", isLastOnDomain(onDomain, "a@g.com", ["b@g.com"]), false);
eq("yes once every other one is already blocked", isLastOnDomain(onDomain, "a@g.com", ["b@g.com", "C@G.com"]), true);
eq("yes when it is the only inbox", isLastOnDomain(["a@g.com"], "A@g.com", []), true);
eq("yes when the domain has none left at all", isLastOnDomain([], "a@g.com", []), true);

console.log("--- when a Microsoft domain is cancelled");
eq("more than 13 deletions, not 13", [shouldCancel({ deletedByRules: 13 }, 13), shouldCancel({ deletedByRules: 14 }, 13)], [false, true]);
eq("…once: not again once cancelled, nor while cancelling", [shouldCancel({ deletedByRules: 20, cancelledAt: 1 }, 13), shouldCancel({ deletedByRules: 20, cancelling: true }, 13)], [false, false]);
eq("the number is the setting's", shouldCancel({ deletedByRules: 6 }, 5), true);

console.log("--- which inboxes a cancellation keeps");
const f = (sent, contacted, replies, ooo) => ({ sent, bounces: 0, contacted, replies, oooReplies: ooo });
const plan = planCancellation([
  { inbox: 1, email: "replying@m.com", figures: f(100, 100, 1, 0) },
  { inbox: 2, email: "ooo-only@m.com", figures: f(100, 100, 0, 2) },
  { inbox: 3, email: "quiet@m.com", figures: f(100, 100, 0, 0) },
  { inbox: 4, email: "just-under@m.com", figures: f(200, 200, 1, 0) },
  { inbox: 5, email: "unread@m.com", figures: null },
  { inbox: 6, email: "idle@m.com", figures: f(0, 0, 0, 0) },
], 1);
eq("kept: at or above the 1% bar, OOO replies counted", plan.keep.map((k) => [k.email, k.oooReplyRate]), [["replying@m.com", 1], ["ooo-only@m.com", 2]]);
eq("cancelled: under the bar, no figures, or nothing sent", plan.cancel.map((c) => c.email), ["quiet@m.com", "just-under@m.com", "unread@m.com", "idle@m.com"]);
eq("the bar is the setting's", planCancellation([{ inbox: 1, email: "x@m.com", figures: f(100, 100, 2, 0) }], 3).keep.length, 0);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
