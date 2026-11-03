// Unit checks for Analyze Positive Reply Rates — Opt Out vs No Opt Out:
// which group a campaign is in, its figures from variation stats, the two
// groups' rates and whether the gap can be trusted. Imports the REAL module.
//
//   node scripts/check-reply-rates.mjs

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

const { groupOf, figuresFrom, compareOptOut, checkRange, compareByWorkspace } = await importTs("@/lib/reply-rates/opt-out");
const { parseVariationStats } = await importTs("@/lib/winning-variants/plan");
const Y = "🟡", B = "🔵";

console.log("--- the groups, by name");
eq("Opt Out, 🟡 or 🔵, any case", [`${Y} eCommerce - Opt Out (August)`, `${B} Apps - Opt Out (August)`, "Local - opt out (July)"].map(groupOf), ["optOut", "optOut", "optOut"]);
eq("Opt Out - Signature counts as Opt Out", [`${Y} Financial - Platform - Opt Out - Signature (August)`, `${B} Financial - Platform - Opt Out - Signature (August)`].map(groupOf), ["optOut", "optOut"]);
eq("everything else is No Opt Out — Signature included", [`${Y} eCommerce (August)`, `${B} Apps (August)`, `${Y} Apps - Signature (August)`, "Optout Co (August)"].map(groupOf), ["noOptOut", "noOptOut", "noOptOut", "noOptOut"]);

console.log("--- a campaign's figures");
{
  const stats = parseVariationStats([
    { step: 2, variations: [{ variation: "A", sent: 900, pos_reply: 3 }] },
    { step: 1, variations: [{ variation: "A", sent: 500, pos_reply: 4 }, { variation: "B", sent: 480, pos_reply: 1, is_del: true }] },
  ]);
  eq("leads emailed: step 1's sends, every variant; positive: every step; each step on its own, in order", figuresFrom(stats), {
    contacted: 980,
    positive: 8,
    steps: [{ step: 1, sent: 980, positive: 5 }, { step: 2, sent: 900, positive: 3 }],
  });
  eq("nothing sent: zeros", figuresFrom(parseVariationStats([])), { contacted: 0, positive: 0, steps: [] });
}

console.log("--- the comparison");
const row = (name, contacted, positive) => ({ workspaceId: "w", workspaceName: "W", campaignId: name, name, contacted, positive });
{
  const r = compareOptOut([
    row(`${Y} A - Opt Out (August)`, 10000, 60),
    row(`${B} A - Opt Out (August)`, 10000, 40),
    row(`${Y} A (August)`, 10000, 30),
    row(`${B} A (August)`, 10000, 20),
    row(`${Y} A - Signature (August)`, 0, 0),
  ]);
  eq("each group's totals and rate per 100 leads", [r.optOut, r.noOptOut], [
    { campaigns: 2, sending: 2, contacted: 20000, positive: 100, rate: 0.5 },
    { campaigns: 3, sending: 2, contacted: 20000, positive: 50, rate: 0.25 },
  ]);
  eq("the gap in points and as a share", [r.difference, r.relative], [0.25, 100]);
  eq("a gap this size on these numbers is real", r.confidence, "likely");
}
{
  const r = compareOptOut([row("X - Opt Out", 1000, 11), row("X", 1000, 10)]);
  eq("a small gap on small numbers could be chance", [r.difference, r.confidence], [0.1, "unclear"]);
  eq("too few positive replies to say", compareOptOut([row("X - Opt Out", 1000, 4), row("X", 1000, 1)]).confidence, "too-few");
  eq("one group sent nothing: nothing to compare", (({ difference, confidence }) => [difference, confidence])(compareOptOut([row("X - Opt Out", 0, 0), row("X", 1000, 5)])), [null, null]);
}

console.log("--- the range");
eq("a good range", checkRange("2026-09-01", "2026-09-30", "2026-10-01"), { start: "2026-09-01", end: "2026-09-30" });
eq("backwards, future, missing", [checkRange("2026-09-30", "2026-09-01", "2026-10-01"), checkRange("2026-09-01", "2026-10-05", "2026-10-01"), checkRange("", "2026-09-01", "2026-10-01")].map((x) => x.problem), [
  "The start date is after the end date.",
  "The end date is in the future.",
  "Pick both dates.",
]);

console.log("--- workspace by workspace");
{
  const w = (ws, name, contacted, positive) => ({ workspaceId: ws, workspaceName: ws.toUpperCase(), campaignId: ws + name, name, contacted, positive });
  const rows = [
    // A: Opt Out clearly ahead.
    w("a", "X - Opt Out", 10000, 60), w("a", "X", 10000, 20),
    // B: No Opt Out clearly ahead.
    w("b", "Y - Opt Out", 10000, 15), w("b", "Y", 10000, 50),
    // C: close.
    w("c", "Z - Opt Out", 1000, 11), w("c", "Z", 1000, 10),
    // D: too few.
    w("d", "Q - Opt Out", 500, 2), w("d", "Q", 500, 1),
    // E: only No Opt Out sent.
    w("e", "R - Opt Out", 0, 0), w("e", "R", 800, 6),
    // F: nothing sent.
    w("f", "S", 0, 0),
    // G: Opt Out ahead by more than A.
    w("g", "T - Opt Out", 20000, 140), w("g", "T", 20000, 40),
  ];
  const by = compareByWorkspace(rows);
  eq("one row per workspace, clear winners first, biggest gap first", by.map((x) => [x.workspaceId, x.verdict]), [
    ["g", "optOut"], ["a", "optOut"], ["b", "noOptOut"], ["c", "even"], ["d", "too-few"], ["e", "one-group"], ["f", "none"],
  ]);
  eq("each with its own figures", (({ optOut, noOptOut }) => [optOut.positive, noOptOut.positive, optOut.contacted])(by[2]), [15, 50, 10000]);
  eq("the workspaces add up to the whole", [by.reduce((n, x) => n + x.optOut.positive + x.noOptOut.positive, 0), compareOptOut(rows).optOut.positive + compareOptOut(rows).noOptOut.positive], [355, 355]);
}

console.log("--- Step 1 vs Step 2");
{
  const { compareSteps, compareStepsByWorkspace, stepsVerdictOf } = await importTs("@/lib/reply-rates/steps");
  const st = (ws, name, steps) => ({ workspaceId: ws, workspaceName: ws.toUpperCase(), campaignId: `${ws}-${name}`, name, contacted: steps[0]?.[0] ?? 0, positive: steps.reduce((n, s) => n + s[1], 0), steps: steps.map(([sent, positive], i) => ({ step: i + 1, sent, positive })) });
  const rows = [
    st("a", "X (August)", [[10000, 60], [8000, 30], [6000, 4]]),
    st("a", "Y - Opt Out (August)", [[5000, 20], [4000, 10]]),
    st("b", "Z (August)", [[3000, 6]]),
    st("b", "Quiet (August)", []),
  ];
  const r = compareSteps(rows);
  eq("each step's positive replies and sends, over every campaign that has it", [r.step1, r.step2], [
    { campaigns: 3, sending: 3, contacted: 18000, positive: 86, rate: 0.48 },
    { campaigns: 2, sending: 2, contacted: 12000, positive: 40, rate: 0.33 },
  ]);
  eq("step 3 and later counted apart; step 1's share of the two", [r.later, r.step1Share], [4, 68.3]);
  eq("the gap per email sent — at z ≈ 1.9, not yet past 95%", [r.difference, r.confidence], [0.15, "unclear"]);
  eq("…a wider gap holds", compareSteps([st("a", "X", [[18000, 120], [12000, 40]])]).confidence, "likely");
  eq("nothing sent: nothing to say", stepsVerdictOf(compareSteps([st("q", "Q", [[0, 0], [0, 0]])])), "none");
  eq("no step 2 anywhere: only one step sent", stepsVerdictOf(compareSteps([st("q", "Q", [[1000, 9]])])), "one-step");
  eq("figures read before steps were kept count as nothing", compareSteps([{ workspaceId: "w", workspaceName: "W", campaignId: "c", name: "C", contacted: 100, positive: 3 }]).step1.positive, 0);
  const by = compareStepsByWorkspace([...rows, st("c", "F (August)", [[2000, 6], [2000, 40]])]);
  eq("by workspace: step 2 clearly ahead first, then step 1, then the rest", by.map((w) => [w.workspaceId, w.verdict]), [["c", "step2"], ["a", "step1"], ["b", "one-step"]]);
  eq("…each with its own counts", by.map((w) => [w.step1.positive, w.step2.positive]), [[6, 40], [80, 40], [6, 0]]);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
