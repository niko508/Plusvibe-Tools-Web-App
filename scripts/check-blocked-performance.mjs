// Unit checks for the Blocked Domains performance check: reading the stats
// payloads, and deciding which inboxes on a blocked domain have to stop.
// Imports the REAL module.
//
//   node scripts/check-blocked-performance.mjs

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

const m = await importTs("@/lib/blocked-domains/performance");
const {
  DEFAULT_MIN_REPLY_RATE_OOO, readStatsRow, indexStats, statsFor, assessInbox,
  planQuarantine, stopEverything, normalizeThreshold, describePlan, REASON_LABELS,
  aggregateDomain, unknownDomain, DEFAULT_MIN_DOMAIN_REPLY_RATE_OOO,
} = m;

// --- reading what the API sends ------------------------------------------------------
eq("the inbox bar defaults to 1%", DEFAULT_MIN_REPLY_RATE_OOO, 1);
eq("the domain bar defaults to 1.5%", DEFAULT_MIN_DOMAIN_REPLY_RATE_OOO, 1.5);
eq("a bulk row, numbers under header", readStatsRow({
  email_acc_id: "i1", email: "A@Acme.com",
  header: { total_sent_count: 94, total_unique_contacted_count: 80, total_reply_count: 6, total_ooo_reply_count: 2, reply_rate: 6.4, reply_rate_with_ooo: 8.8 },
}), { id: "i1", email: "a@acme.com", sent: 94, contacted: 80, replies: 6, oooReplies: 2, replyRate: 6.4, replyRateOoo: 8.8 });
eq("contacted falls back through the API's three spellings", [
  readStatsRow({ id: "c1", email: "c1@x.com", header: { total_new_lead_contacted_count: 40, total_contacted_count: 99 } }).contacted,
  readStatsRow({ id: "c2", email: "c2@x.com", header: { total_contacted_count: 99 } }).contacted,
], [40, 99]);
eq("a flat row, numbers at the top", readStatsRow({ id: "i2", email: "b@acme.com", total_sent_count: 10, reply_rate: 0, reply_rate_with_ooo: 0.5 }).replyRateOoo, 0.5);
eq("_id is accepted too", readStatsRow({ _id: "i3", email: "c@acme.com", header: {} }).id, "i3");
eq("missing numbers read as zero, not NaN", readStatsRow({ id: "i4", email: "d@acme.com", header: {} }), { id: "i4", email: "d@acme.com", sent: 0, contacted: 0, replies: 0, oooReplies: 0, replyRate: 0, replyRateOoo: 0 });
eq("numbers sent as strings are read", readStatsRow({ id: "i5", email: "e@acme.com", header: { total_sent_count: "40", reply_rate_with_ooo: "2.5" } }).replyRateOoo, 2.5);
eq("a row with no id and no email is not a row", readStatsRow({ header: { reply_rate: 5 } }), null);

// --- looking a mailbox up ----------------------------------------------------------------
const ROWS = [
  readStatsRow({ email_acc_id: "i1", email: "a@acme.com", header: { total_sent_count: 100, reply_rate: 2, reply_rate_with_ooo: 3 } }),
  readStatsRow({ email_acc_id: "", email: "B@acme.com", header: { total_sent_count: 50, reply_rate: 0, reply_rate_with_ooo: 0.4 } }),
];
const INDEX = indexStats(ROWS);
eq("found by account id", statsFor({ id: "i1", email: "nope@x.com" }, INDEX)?.replyRateOoo, 3);
eq("found by address when the id is missing", statsFor({ id: "i9", email: "b@acme.com" }, INDEX)?.replyRateOoo, 0.4);
eq("…whatever the case", statsFor({ id: "i9", email: "B@ACME.COM" }, INDEX)?.replyRateOoo, 0.4);
eq("an inbox with no row is not found", statsFor({ id: "zz", email: "z@acme.com" }, INDEX), undefined);

// --- one inbox ------------------------------------------------------------------------------
const s = (sent, ooo, plain = 0) => ({ id: "i", email: "a@acme.com", sent, contacted: sent, replies: 0, oooReplies: 0, replyRate: plain, replyRateOoo: ooo });
const IN = { id: "i", email: "a@acme.com" };
eq("above the bar keeps sending", assessInbox(IN, s(100, 3), 1).decision, "keep");
eq("exactly at the bar keeps sending", assessInbox(IN, s(100, 1), 1).decision, "keep");
eq("just under the bar is stopped", assessInbox(IN, s(100, 0.9), 1), { id: "i", email: "a@acme.com", sent: 100, replyRate: 0, replyRateOoo: 0.9, decision: "stop", reason: "under-bar" });
eq("zero replies is stopped", assessInbox(IN, s(100, 0), 1).reason, "under-bar");
eq("nothing sent is stopped, and says so", assessInbox(IN, s(0, 0), 1).reason, "no-sends");
eq("…even if the rate reads high on no sends", assessInbox(IN, s(0, 50), 1).decision, "stop");
eq("no figures at all is stopped, and says so", assessInbox(IN, undefined, 1), { id: "i", email: "a@acme.com", decision: "stop", reason: "no-stats" });
eq("the OOO figure is what counts, not the plain one", assessInbox(IN, s(100, 2, 0), 1).decision, "keep");
eq("…and a good plain rate can't save a low OOO one", assessInbox(IN, s(100, 0.2, 9), 1).decision, "stop");
eq("a higher bar stops more", assessInbox(IN, s(100, 3), 5).decision, "stop");
eq("a zero bar keeps anything that sent", assessInbox(IN, s(100, 0), 0).decision, "keep");

// --- a whole domain --------------------------------------------------------------------------
const INBOXES = [
  { id: "i1", email: "a@acme.com" },   // 3% with OOO → keep
  { id: "i2", email: "b@acme.com" },   // 0.4% → stop
  { id: "i3", email: "c@acme.com" },   // no row → stop
];
const plan = planQuarantine(INBOXES, INDEX, 1);
eq("only the under-performing and unknown ones are stopped", plan.stop.map((i) => i.id), ["i2", "i3"]);
eq("the performing one is kept", plan.keep.map((i) => i.id), ["i1"]);
eq("every inbox is accounted for, in order", plan.assessments.map((a) => `${a.email}:${a.decision}/${a.reason}`), [
  "a@acme.com:keep/performing", "b@acme.com:stop/under-bar", "c@acme.com:stop/no-stats",
]);
eq("the summary reads well", describePlan(plan), "2 stopped, 1 left sending");
eq("an all-performing domain stops nothing", planQuarantine([INBOXES[0]], INDEX, 1).stop, []);
eq("…and says so", describePlan(planQuarantine([INBOXES[0]], INDEX, 1)), "0 stopped, 1 left sending");
eq("no inboxes plans nothing", planQuarantine([], INDEX, 1), { assessments: [], stop: [], keep: [] });

// The safety net: no stats at all must never read as "everyone is fine".
const blind = planQuarantine(INBOXES, new Map(), 1);
eq("with no stats at all, everything is stopped", blind.stop.length === 3 && blind.keep.length === 0, true);
const forced = stopEverything(INBOXES);
eq("stopEverything stops all and marks them not checked", [forced.stop.length, forced.keep.length, forced.assessments[0].reason], [3, 0, "not-checked"]);

// --- the domain as a whole ----------------------------------------------------------------------
const row = (sent, contacted, replies, ooo, rate = 0, rateOoo = 0) =>
  readStatsRow({ email_acc_id: `x${sent}${contacted}${replies}${ooo}`, email: `x${sent}-${contacted}-${replies}-${ooo}@d.com`, header: {
    total_sent_count: sent, total_unique_contacted_count: contacted, total_reply_count: replies,
    total_ooo_reply_count: ooo, reply_rate: rate, reply_rate_with_ooo: rateOoo,
  } });

const agg = aggregateDomain([row(500, 400, 8, 4), row(100, 80, 0, 0)], 1);
eq("the domain rate is summed, not averaged per inbox", [agg.replyRate, agg.replyRateOoo], [1.67, 2.5]);
eq("…from replies + OOO over unique contacted", [agg.replies, agg.oooReplies, agg.contacted, agg.sent], [8, 4, 480, 600]);
eq("…and it counts as a real aggregate", [agg.basis, agg.verdict, agg.inboxes], ["counts", "performing", 2]);

// The whole point of summing: a tiny mailbox with one reply must not carry a
// domain that is otherwise silent.
const skewed = aggregateDomain([row(5, 4, 1, 0), row(900, 800, 0, 0)], 1);
eq("a small lucky mailbox can't rescue a silent domain", [skewed.replyRateOoo, skewed.verdict], [0.12, "under"]);
eq("…where a plain average of the two rates would have said otherwise", (25 + 0) / 2 >= 1, true);

eq("a domain right on the bar is performing", aggregateDomain([row(100, 100, 1, 0)], 1).verdict, "performing");
// The two bars are independent: 1.2% clears the inbox bar but not the domain one.
eq("at the default bars, 1.2% is a kept domain's weak inbox territory", [
  assessInbox(IN, s(1000, 1.2), DEFAULT_MIN_REPLY_RATE_OOO).decision,
  aggregateDomain([row(1000, 1000, 12, 0)], DEFAULT_MIN_DOMAIN_REPLY_RATE_OOO).verdict,
], ["keep", "under"]);
eq("…and 1.6% clears both", [
  assessInbox(IN, s(1000, 1.6), DEFAULT_MIN_REPLY_RATE_OOO).decision,
  aggregateDomain([row(1000, 1000, 16, 0)], DEFAULT_MIN_DOMAIN_REPLY_RATE_OOO).verdict,
], ["keep", "performing"]);
eq("…while 0.5% fails both", [
  assessInbox(IN, s(1000, 0.5), DEFAULT_MIN_REPLY_RATE_OOO).decision,
  aggregateDomain([row(1000, 1000, 5, 0)], DEFAULT_MIN_DOMAIN_REPLY_RATE_OOO).verdict,
], ["stop", "under"]);
eq("…just under is not", aggregateDomain([row(100, 100, 0, 0)], 1).verdict, "under");
eq("OOO replies count towards it", aggregateDomain([row(100, 100, 0, 2)], 1).verdict, "performing");
eq("a higher bar flips it", aggregateDomain([row(100, 100, 2, 0)], 5).verdict, "under");

const weighted = aggregateDomain([
  readStatsRow({ email_acc_id: "w1", email: "w1@d.com", header: { total_sent_count: 900, reply_rate: 0, reply_rate_with_ooo: 0 } }),
  readStatsRow({ email_acc_id: "w2", email: "w2@d.com", header: { total_sent_count: 100, reply_rate: 5, reply_rate_with_ooo: 10 } }),
], 1);
eq("with no denominator the rates are weighted by sends", [weighted.basis, weighted.replyRateOoo, weighted.verdict], ["weighted", 1, "performing"]);
eq("no inboxes at all is unknown, never performing", aggregateDomain([], 1).verdict, "unknown");
eq("a domain that sent nothing is unknown, never performing", aggregateDomain([row(0, 0, 0, 0)], 1).verdict, "unknown");
eq("unknownDomain is unknown and empty", [unknownDomain(4).verdict, unknownDomain(4).inboxes, unknownDomain(4).basis], ["unknown", 4, "none"]);

// --- the bar itself ---------------------------------------------------------------------------
eq("a number passes through", normalizeThreshold(2.5), 2.5);
eq("a numeric string is read", normalizeThreshold("0.5"), 0.5);
eq("zero is allowed", normalizeThreshold(0), 0);
eq("nonsense falls back to the default", normalizeThreshold("abc"), 1);
eq("…or to whichever default is asked for", normalizeThreshold("abc", 1.5), 1.5);
eq("a blank domain bar falls back to 1.5, never 0", normalizeThreshold("", DEFAULT_MIN_DOMAIN_REPLY_RATE_OOO), 1.5);
eq("undefined falls back to the default", normalizeThreshold(undefined), 1);
eq("a negative bar falls back to the default", normalizeThreshold(-3), 1);
eq("over 100 is clamped", normalizeThreshold(150), 100);
eq("every reason has a label", Object.keys(REASON_LABELS).sort(), ["no-sends", "no-stats", "not-checked", "performing", "under-bar"]);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
