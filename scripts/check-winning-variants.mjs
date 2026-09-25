// Unit checks for Clone Campaign with Winning Variants: reading Plusvibe's
// variation stats, which step-1 variants win, the top three, the empty step
// when nothing won, and the clone's tags. Imports the REAL module.
//
//   node scripts/check-winning-variants.mjs

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

const { parseVariationStats, planWinners, planProblems, tagChanges, cleanTagName, defaultName, emptyVariant } = await importTs("@/lib/winning-variants/plan");

// As the documented endpoint answers, grouped by step.
const RAW = [
  {
    step: 1,
    variations: [
      { variation: "A", sent: 600, open: 0, reply: 30, pos_reply: 9, name: "-", is_active: true, is_del: false },
      { variation: "B", sent: 610, open: 0, reply: 12, pos_reply: 0, name: "-", is_active: true, is_del: false },
      { variation: "C", sent: 590, open: 0, reply: 20, pos_reply: 4, name: "-", is_active: true, is_del: false },
      { variation: "D", sent: 300, open: 0, reply: 9, pos_reply: 4, name: "-", is_active: true, is_del: false },
      { variation: "E", sent: 580, open: 0, reply: 6, pos_reply: 1, name: "-", is_active: true, is_del: false },
      { variation: "F", sent: 50, open: 0, reply: 5, pos_reply: 5, name: "-", is_active: false, is_del: true },
    ],
  },
  { step: 2, variations: [{ variation: "A", sent: 900, reply: 10, pos_reply: 0, is_active: true, is_del: false }, { variation: "B", sent: 890, reply: 0, pos_reply: 0, is_active: true, is_del: false }] },
];
const v = (letter, subject = `Subject ${letter}`) => ({ variation: letter, subject, preheader: "", name: "", body: `<div>${letter}</div>` });
const SEQ = [
  { step: 2, wait_time: 3, variations: [v("A", "Re: follow up"), v("B", "")] },
  { step: 1, wait_time: 0, variations: ["A", "B", "C", "D", "E", "F"].map((l) => v(l)) },
  { step: 3, wait_time: 5, variations: [v("A", "")] },
];

console.log("--- reading the stats");
{
  const s = parseVariationStats(RAW);
  eq("grouped by step and letter, with positive replies", [s.get(1).get("A").positiveReplies, s.get(1).get("A").replies, s.get(1).get("A").sent], [9, 30, 600]);
  eq("…and which are deleted", [s.get(1).get("F").isDel, s.get(1).get("A").isDel], [true, false]);
  eq("anything unreadable is nothing, not a crash", [parseVariationStats(null).size, parseVariationStats([{ step: "x" }]).size], [0, 0]);
}

console.log("--- step 1: only the winners");
{
  const p = planWinners(SEQ, parseVariationStats(RAW));
  eq("the first step is the one judged, whatever order the steps come in", p.firstStep, 1);
  eq("every variant with a positive reply is kept; none without", p.rows.map((r) => [r.variation, r.kept]), [["A", true], ["B", false], ["C", true], ["D", true], ["E", true]]);
  eq("…a deleted variant never shows, however well it did", [p.rows.some((r) => r.variation === "F"), p.droppedDeleted], [false, 1]);
  eq("the clone's step 1 holds the winners, under their own letters", p.steps[0].variations.map((x) => x.variation), ["A", "C", "D", "E"]);
  eq("…with their copy", p.steps[0].variations.map((x) => x.body), ["<div>A</div>", "<div>C</div>", "<div>D</div>", "<div>E</div>"]);
  eq("the top three: most positive replies, then most replies", p.top3.map((r) => [r.variation, r.positiveReplies]), [["A", 9], ["C", 4], ["D", 4]]);
  eq("the positive reply rate is per 100 sent", p.rows.find((r) => r.variation === "D").positiveRate, 1.33);
  eq("counts", [p.kept, p.dropped, p.noWinners], [4, 1, false]);
}

console.log("--- the follow-ups are kept as they are");
{
  const p = planWinners(SEQ, parseVariationStats(RAW));
  eq("every follow-up step, every variant, in order — no positive replies needed", p.steps.slice(1).map((s) => [s.step, s.variations.map((x) => x.variation)]), [[2, ["A", "B"]], [3, ["A"]]]);
  eq("…with their waits", p.steps.map((s) => s.wait_time), [0, 3, 5]);
  eq("…listed for the preview", p.followUps, [{ step: 2, variations: 2 }, { step: 3, variations: 1 }]);
}

console.log("--- no winners in step 1");
{
  const none = RAW.map((s) => ({ ...s, variations: s.variations.map((x) => ({ ...x, pos_reply: 0 })) }));
  const p = planWinners(SEQ, parseVariationStats(none));
  eq("it says so", [p.noWinners, p.kept, p.top3], [true, 0, []]);
  eq("step 1 becomes one empty variant", p.steps[0].variations, [emptyVariant()]);
  eq("…and the follow-ups still stay", p.steps.slice(1).map((s) => s.variations.length), [2, 1]);
  const fresh = planWinners(SEQ, parseVariationStats([]));
  eq("a campaign with no stats at all has no winners either", [fresh.noWinners, fresh.rows.every((r) => r.sent === 0)], [true, true]);
}

console.log("--- choices");
{
  eq("everything missing is named", planProblems({}), ["Pick a workspace.", "Pick the campaign to clone.", "Give the new campaign a name."]);
  eq("an empty campaign is caught before anything is made", planProblems({ workspaceId: "w", campaignId: "c", name: "x" }, { steps: 0 }), ["That campaign has no sequence steps, so there is nothing to clone."]);
  eq("the name starts as the source's own", defaultName("  Roof Repair (August) "), "Roof Repair (August)");
  eq("a long subject is cut for the table", planWinners([{ step: 1, variations: [v("A", "x".repeat(300))] }], new Map()).rows[0].subject.length, 90);
}

console.log("--- tags");
{
  eq("the clone is brought to the chosen set", tagChanges(["t1", "t2"], ["t2", "t3"]), { add: ["t3"], remove: ["t1"] });
  eq("…nothing to do when it already matches", tagChanges(["t1"], ["t1"]), { add: [], remove: [] });
  eq("…and all of them can come off", tagChanges(["t1", "t2"], []), { add: [], remove: ["t1", "t2"] });
  eq("a typed tag name is tidied, an empty one ignored", [cleanTagName("  Winners   Q3 "), cleanTagName("   ")], ["Winners Q3", null]);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
