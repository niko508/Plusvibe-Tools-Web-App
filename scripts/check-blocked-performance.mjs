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
} = m;

// --- reading what the API sends ------------------------------------------------------
eq("the bar defaults to 1%", DEFAULT_MIN_REPLY_RATE_OOO, 1);
eq("a bulk row, numbers under header", readStatsRow({
  email_acc_id: "i1", email: "A@Acme.com",
  header: { total_sent_count: 94, total_reply_count: 6, total_ooo_reply_count: 2, reply_rate: 6.4, reply_rate_with_ooo: 8.8 },
}), { id: "i1", email: "a@acme.com", sent: 94, replies: 6, oooReplies: 2, replyRate: 6.4, replyRateOoo: 8.8 });
eq("a flat row, numbers at the top", readStatsRow({ id: "i2", email: "b@acme.com", total_sent_count: 10, reply_rate: 0, reply_rate_with_ooo: 0.5 }).replyRateOoo, 0.5);
eq("_id is accepted too", readStatsRow({ _id: "i3", email: "c@acme.com", header: {} }).id, "i3");
eq("missing numbers read as zero, not NaN", readStatsRow({ id: "i4", email: "d@acme.com", header: {} }), { id: "i4", email: "d@acme.com", sent: 0, replies: 0, oooReplies: 0, replyRate: 0, replyRateOoo: 0 });
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
const s = (sent, ooo, plain = 0) => ({ id: "i", email: "a@acme.com", sent, replies: 0, oooReplies: 0, replyRate: plain, replyRateOoo: ooo });
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

// --- the bar itself ---------------------------------------------------------------------------
eq("a number passes through", normalizeThreshold(2.5), 2.5);
eq("a numeric string is read", normalizeThreshold("0.5"), 0.5);
eq("zero is allowed", normalizeThreshold(0), 0);
eq("nonsense falls back to the default", normalizeThreshold("abc"), 1);
eq("undefined falls back to the default", normalizeThreshold(undefined), 1);
eq("a negative bar falls back to the default", normalizeThreshold(-3), 1);
eq("over 100 is clamped", normalizeThreshold(150), 100);
eq("every reason has a label", Object.keys(REASON_LABELS).sort(), ["no-sends", "no-stats", "not-checked", "performing", "under-bar"]);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
