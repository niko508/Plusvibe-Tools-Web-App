// Unit checks for re-judging a blocked domain under the current rules.
// Imports the REAL module.
//
//   node scripts/check-blocked-rejudge.mjs

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

const m = await importTs("@/lib/blocked-domains/rejudge");
const { rejudgeWindow, planRejudge, suggestLimit, normalizeLimit, DAY_MS } = m;

// --- the window --------------------------------------------------------------
const NOW = Date.parse("2026-09-09T12:00:00Z");
eq("reaches back a week before the domain was flagged",
  rejudgeWindow(NOW - 3 * DAY_MS, NOW), { start: NOW - 10 * DAY_MS, end: NOW });
eq("…but never more than 30 days back",
  rejudgeWindow(NOW - 60 * DAY_MS, NOW), { start: NOW - 30 * DAY_MS, end: NOW });
eq("a domain flagged just now still gets its week of history",
  rejudgeWindow(NOW, NOW).start, NOW - 7 * DAY_MS);

// --- the plan ----------------------------------------------------------------
const ib = (email, decision, stoppedByUs, sendingNow = !stoppedByUs) =>
  ({ id: email, email, decision, reason: decision === "keep" ? "performing" : "under-bar", stoppedByUs, sendingNow });
const D = (verdict) => ({ inboxes: 0, sent: 0, contacted: 0, replies: 0, oooReplies: 0, replyRate: 0, replyRateOoo: 0, basis: "counts", verdict });

const mixed = [
  ib("a@x.com", "keep", true),   // we stopped it; it clears the bar now → restorable
  ib("b@x.com", "stop", true),   // we stopped it; still under
  ib("c@x.com", "keep", false),  // never stopped, fine
  ib("d@x.com", "stop", false),  // never stopped by us, under (stopped by hand, or sending and weak)
];
const p = planRejudge({ inboxes: mixed, domain: D("performing"), googlePath: false });
eq("only what we stopped AND clears the bar is restorable", p.restorable, ["a@x.com"]);
eq("everything under the bar is still under, stopped by us or not", p.stillUnder, ["b@x.com", "d@x.com"]);
eq("a performing domain would not be written off", p.wouldWriteOff, false);
eq("…and an under one would, on the tenant path",
  planRejudge({ inboxes: mixed, domain: D("under"), googlePath: false }).wouldWriteOff, true);
eq("on the Google path the domain's verdict is not what decides",
  planRejudge({ inboxes: mixed, domain: D("under"), googlePath: true }).wouldWriteOff, false);
eq("…every inbox burned is", planRejudge({
  inboxes: [ib("a@x.com", "stop", true), ib("b@x.com", "stop", false)], domain: D("performing"), googlePath: true,
}).wouldWriteOff, true);
eq("no inboxes at all is not 'every inbox burned'",
  planRejudge({ inboxes: [], domain: D("unknown"), googlePath: true }).wouldWriteOff, false);
eq("nothing stopped by us → nothing restorable, whatever the bar says",
  planRejudge({ inboxes: [ib("a@x.com", "keep", false)], domain: D("performing"), googlePath: false }).restorable, []);

// --- the suggested limit -----------------------------------------------------
eq("the limit most sending inboxes use", suggestLimit([
  { dailyLimit: 30 }, { dailyLimit: 30 }, { dailyLimit: 50 }, { dailyLimit: 0 }, {},
]), 30);
eq("a tie goes to the higher limit", suggestLimit([{ dailyLimit: 30 }, { dailyLimit: 50 }]), 50);
eq("stopped inboxes don't vote", suggestLimit([{ dailyLimit: 0 }, { dailyLimit: 0 }]), undefined);
eq("nothing sending → no suggestion", suggestLimit([]), undefined);

// --- a typed limit -----------------------------------------------------------
eq("a whole number in range", normalizeLimit(30), 30);
eq("…as text too", normalizeLimit(" 25 "), 25);
eq("…rounded", normalizeLimit(29.6), 30);
eq("zero is not a restore", normalizeLimit(0), null);
eq("neither is a blank", normalizeLimit(""), null);
eq("…nor nonsense", normalizeLimit("lots"), null);
eq("…nor an absurd one", normalizeLimit(5000), null);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
