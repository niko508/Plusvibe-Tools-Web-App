// Unit checks for the Inbox Performance Monitoring numbers. Imports the REAL
// module.
//
//   node scripts/check-inbox-performance.mjs

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

const m = await importTs("@/lib/inbox-performance/metrics");
const { ratesFromHeader, sumTotals, isBurned, rangeDays, rangeProblem, chunk, readBulkRow, normalizeChart, aggregateChart, MAX_RANGE_DAYS, BULK_CHUNK } = m;

const H = (over = {}) => ({
  total_sent_count: 300, total_reply_count: 3, total_ooo_reply_count: 1, total_open_count: 0,
  total_bounce_count: 6, total_contacted_count: 100, total_completed_count: 0, total_pos_reply_count: 2,
  // Plusvibe's own per-sent figures, deliberately wrong so a check that reads
  // them fails.
  bounce_rate: 99, open_rate: 0, reply_rate: 1, reply_rate_with_ooo: 1.33, pos_reply_rate: 99,
  ...over,
});

// --- rates over unique contacts, never over sends ----------------------------
const r = ratesFromHeader(H());
eq("true reply rate is replies over unique contacted", r.replyRate, 3);
eq("…not Plusvibe's per-sent figure", r.replyRate !== 1, true);
eq("reply rate with OOO adds the OOO replies", r.replyRateOoo, 4);
eq("positive rate is over replies", r.posRate, 66.67);
eq("bounce rate stays over sends, which is what a bounce is a share of", r.bounceRate, 2);
eq("the unique count is preferred when the API gives it",
  ratesFromHeader(H({ total_unique_contacted_count: 50 })).replyRate, 6);
eq("…then the new-lead spelling", ratesFromHeader(H({ total_new_lead_contacted_count: 25 })).replyRate, 12);
eq("no contacts → zero rates, not NaN", ratesFromHeader(H({ total_contacted_count: 0 })).replyRateOoo, 0);
eq("no replies → zero positive rate", ratesFromHeader(H({ total_reply_count: 0, total_pos_reply_count: 0 })).posRate, 0);

// --- totals recompute from sums --------------------------------------------------
const a = ratesFromHeader(H());                                   // 3 / 100
const b = ratesFromHeader(H({ total_contacted_count: 900, total_reply_count: 0, total_ooo_reply_count: 0, total_sent_count: 900, total_bounce_count: 0 })); // 0 / 900
const t = sumTotals([a, b]);
eq("totals sum the counts", [t.count, t.contacted, t.replies, t.sent], [2, 1000, 3, 1200]);
eq("…and recompute the rate from the sums, not the average of two rates", t.replyRate, 0.3);
eq("empty totals", sumTotals([]).replyRate, 0);

// --- burned ----------------------------------------------------------------------
eq("under the threshold and no OOO → burned", isBurned({ ...a, replyRate: 0.1, replyRateOoo: 0.5 }, 0.2), true);
eq("under the threshold but OOO says it delivers → not burned", isBurned({ ...a, replyRate: 0.1, replyRateOoo: 2 }, 0.2), false);
eq("at the threshold → not burned", isBurned({ ...a, replyRate: 0.2, replyRateOoo: 0 }, 0.2), false);

// --- the range -----------------------------------------------------------------
eq("inclusive days", rangeDays("2026-09-01", "2026-09-09"), 9);
eq("a single day is one", rangeDays("2026-09-09", "2026-09-09"), 1);
eq("90 days is allowed", rangeProblem("2026-06-12", "2026-09-09"), null);
eq("91 days is not", rangeProblem("2026-06-11", "2026-09-09"), `Plusvibe reports at most ${MAX_RANGE_DAYS} days at a time; this range is 91.`);
eq("end before start", rangeProblem("2026-09-09", "2026-09-01"), "The end date is before the start date.");
eq("a blank date", rangeProblem("", "2026-09-09"), "Pick a start and an end date.");

// --- chunks ----------------------------------------------------------------------
eq("ids are chunked at the endpoint's limit", chunk(Array.from({ length: 250 }, (_, i) => i), BULK_CHUNK).map((c) => c.length), [100, 100, 50]);
eq("nothing → no chunks", chunk([], 100), []);

// --- reading the bulk row --------------------------------------------------------
const row = readBulkRow({
  email_acc_id: "abc", email: "Sales@Example.com",
  header: { total_sent_count: "94", total_reply_count: 6, total_ooo_reply_count: 1, total_bounce_count: 1, total_pos_reply_count: 4, total_contacted_count: 80, total_new_lead_contacted_count: 80, reply_rate: 7.5 },
  chart: [
    { label: "2 Mar 26", date: "2026-03-02", total_sent_count: 45, total_new_lead_contacted_count: 38 },
    { label: "1 Mar 26", date: "2026-03-01", total_sent_count: 49, total_reply_count: 1, total_new_lead_contacted_count: 42 },
  ],
});
eq("the id and a lower-cased address", [row.id, row.email], ["abc", "sales@example.com"]);
eq("numbers sent as strings are read", row.header.total_sent_count, 94);
eq("the new-lead count is kept for the unique denominator", row.header.total_new_lead_contacted_count, 80);
eq("…so the rate comes out over contacts", ratesFromHeader(row.header).replyRate, 7.5);
eq("the chart is sorted by date", row.chart.map((p) => p.date), ["2026-03-01", "2026-03-02"]);
eq("…with the chart's contacted spelling carried across", row.chart[0].total_contacted_count, 42);
eq("missing chart numbers read as zero", row.chart[0].total_bounce_count, 0);
eq("a row with nothing to identify it is dropped", readBulkRow({ header: {} }), null);
eq("no chart when the API sent none", readBulkRow({ email_acc_id: "x", header: {} }).chart, undefined);

// --- the overview chart ------------------------------------------------------------
const agg = aggregateChart([row.chart, normalizeChart([{ date: "2026-03-01", total_sent_count: 1, total_reply_count: 2 }])]);
eq("days are summed across inboxes", agg.map((p) => [p.date, p.total_sent_count, p.total_reply_count]), [["2026-03-01", 50, 3], ["2026-03-02", 45, 0]]);
eq("no charts → empty", aggregateChart([]), []);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
