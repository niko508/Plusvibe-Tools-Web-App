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

const { parseVariationStats, planWinners, planMultiWinners, planProblems, tagChanges, cleanTagName, defaultName, emptyVariant, withWinnerMark, winnerBar, WINNER_MARK } = await importTs("@/lib/winning-variants/plan");

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
  eq("the clone's step 1 holds the winners, the Previous Winner first, lettered on", p.steps[0].variations.map((x) => x.variation), ["A", "B", "C", "D"]);
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

console.log("--- the opt-out line on the kept variants");
{
  const { OPT_OUT_SPINTAX } = await importTs("@/lib/campaign-types/opt-out-spintax");
  const { PREVIOUS_OPT_OUT_SPINTAX } = await importTs("@/lib/campaign-types/opt-out-spintax-previous");
  const { defaultOptOut } = await importTs("@/lib/winning-variants/plan");
  const count = (s, sub) => s.split(sub).length - 1;
  const withBody = (letter, body) => ({ variation: letter, subject: `S ${letter}`, preheader: "", name: "", body });
  const seq = [
    {
      step: 1,
      variations: [
        withBody("A", "<div>Plain A</div><div>{{sender_first_name}}</div>"),
        withBody("B", `<div>Old B</div><div>&nbsp;</div><div>${PREVIOUS_OPT_OUT_SPINTAX}</div>`),
        withBody("C", `<div>Current C</div><div>&nbsp;</div><div>${OPT_OUT_SPINTAX.replace(/"/g, "&quot;")}</div>`),
        withBody("D", `<div>Loser D</div><div>&nbsp;</div><div>${OPT_OUT_SPINTAX}</div>`),
      ],
    },
    { step: 2, variations: [withBody("A", `<div>Bump</div><div>&nbsp;</div><div>${OPT_OUT_SPINTAX}</div>`)] },
  ];
  const stats = parseVariationStats([
    { step: 1, variations: [{ variation: "A", sent: 10, pos_reply: 1 }, { variation: "B", sent: 10, pos_reply: 1 }, { variation: "C", sent: 10, pos_reply: 1 }, { variation: "D", sent: 10, pos_reply: 0 }] },
  ]);
  const first = (p) => p.steps[0].variations;

  const look = planWinners(seq, stats);
  eq("each variant says whether it has the line", look.rows.map((r) => [r.variation, r.optOut]), [["A", "none"], ["B", "older"], ["C", "current"], ["D", "current"]]);
  eq("left unsaid, the bodies are untouched", first(look).map((v) => v.body), seq[0].variations.slice(0, 3).map((v) => v.body));
  eq("the box starts ticked when most kept variants have it (2 of 3)", defaultOptOut(look.rows), true);
  eq("…unticked when most don't", defaultOptOut(look.rows.map((r) => ({ ...r, optOut: r.variation === "C" ? "current" : "none" }))), false);
  eq("…and unticked when nothing is kept", defaultOptOut(look.rows.map((r) => ({ ...r, kept: false }))), false);

  const add = planWinners(seq, stats, "add");
  eq("ticked: added where missing, older swapped, current kept", [add.optOut.added, add.optOut.replaced, add.optOut.present], [["A"], ["B"], ["C"]]);
  const { optOutState } = await importTs("@/lib/campaign-types/append-opt-out");
  eq("…every kept variant carries exactly one block, the current one", first(add).map((v) => [count(v.body, OPT_OUT_SPINTAX) + count(v.body, OPT_OUT_SPINTAX.replace(/"/g, "&quot;")), optOutState(v.body)]), [[1, "current"], [1, "current"], [1, "current"]]);
  eq("…the variant with it already is left byte for byte", first(add)[2].body, seq[0].variations[2].body);
  eq("…and the copy before it stays", [first(add)[0].body.startsWith("<div>Plain A</div>"), first(add)[1].body.startsWith("<div>Old B</div>")], [true, true]);

  const remove = planWinners(seq, stats, "remove");
  eq("unticked: taken out of every kept variant that had it", remove.optOut.removed, ["B", "C"]);
  eq("…current or older, with its spacer, leaving the copy", first(remove).map((v) => v.body), ["<div>Plain A</div><div>{{sender_first_name}}</div>", "<div>Old B</div>", "<div>Current C</div>"]);
  eq("the follow-ups keep theirs either way", [add.steps[1].variations[0].body, remove.steps[1].variations[0].body], [seq[1].variations[0].body, seq[1].variations[0].body]);

  const none = planWinners(seq, parseVariationStats([{ step: 1, variations: [] }]), "add");
  eq("no winners: the empty variant stays empty", [none.noWinners, first(none)[0].body, none.optOut.added], [true, "", []]);
}

console.log("--- winners from several campaigns");
{
  const { withCurrentOptOut } = await importTs("@/lib/campaign-types/append-opt-out");
  const v = (variation, subject, body) => ({ variation, subject, preheader: "", name: "", body });
  const st = (rows) => parseVariationStats([{ step: 1, variations: rows.map(([variation, sent, pos, del]) => ({ variation, sent, reply: pos * 2, pos_reply: pos, is_del: !!del })) }]);
  const base = {
    id: "y", name: "🟡 Apps (August)",
    sequence: [
      { step: 1, wait_time: 0, variations: [v("A", "Quick idea", "<p>Hi</p>"), v("B", "Loser", "<p>No</p>")] },
      { step: 2, wait_time: 3, variations: [v("A", "", "<p>Bump</p>")] },
    ],
    stats: st([["A", 500, 2], ["B", 500, 0]]),
  };
  const blue = {
    id: "b", name: "🔵 Apps (August)",
    sequence: [{ step: 1, wait_time: 0, variations: [v("A", "Quick idea", "<p>Hi</p>"), v("B", "Loser", "<p>No</p>")] }],
    stats: st([["A", 300, 3], ["B", 300, 0]]),
  };
  const other = {
    id: "o", name: "🟡 Local (August)",
    sequence: [{ step: 1, wait_time: 0, variations: [v("A", "Local hook", "<p>Hey</p>"), v("B", "quick  IDEA", withCurrentOptOut("<p>Hi</p>").body), v("C", "Gone", "<p>x</p>")] }],
    stats: st([["A", 400, 7], ["B", 100, 1], ["C", 100, 9, true]]),
  };
  const p = planMultiWinners(base, [base, blue, other], "keep");
  eq("each campaign's variants and winners", p.campaigns, [
    { id: "y", name: "🟡 Apps (August)", variants: 2, winners: 1 },
    { id: "b", name: "🔵 Apps (August)", variants: 2, winners: 1 },
    { id: "o", name: "🟡 Local (August)", variants: 2, winners: 2 },
  ]);
  eq("the same email in three campaigns is one variant, figures added; strongest first", p.steps[0].variations.map((x) => [x.variation, x.subject]), [["A", "Local hook"], ["B", "Quick idea"]]);
  eq("…its figures summed", p.top3.map((r) => [r.variation, r.positiveReplies, r.sent]), [["A", 7, 400], ["B", 6, 900]]);
  eq("…the strongest copy's wording kept (the 🔵 one, 3 positive)", p.top3[1].campaignName, "🔵 Apps (August)");
  eq("two counted into another; a deleted variant left out", [p.merged, p.droppedDeleted, p.kept], [2, 1, 2]);
  eq("each row says where it went", p.rows.map((r) => [r.campaignId, r.variation, r.kept, r.newLetter ?? null, r.sameAs ?? null]), [
    ["y", "A", true, "B", "🔵 Apps (August) · A"],
    ["y", "B", false, null, null],
    ["b", "A", true, "B", null],
    ["b", "B", false, null, null],
    ["o", "A", true, "A", null],
    ["o", "B", true, "B", "🔵 Apps (August) · A"],
  ]);
  eq("follow-ups are the base's", [p.followUps, p.steps.length, p.steps[1].variations[0].body], [[{ step: 2, variations: 1 }], 2, "<p>Bump</p>"]);
  const none = planMultiWinners(base, [{ ...base, stats: st([["A", 1, 0], ["B", 1, 0]]) }, { ...blue, stats: st([["A", 1, 0], ["B", 1, 0]]) }], "keep");
  eq("no winners anywhere: one empty variant", [none.noWinners, none.steps[0].variations.length, none.steps[0].variations[0].body], [true, 1, ""]);
  const added = planMultiWinners(base, [base, blue, other], "add");
  eq("the opt-out choice applies to the clone's step 1", added.optOut.added.length + added.optOut.present.length + added.optOut.replaced.length, 2);
  const many = { id: "m", name: "Many", sequence: [{ step: 1, wait_time: 0, variations: Array.from({ length: 110 }, (_, i) => v(`V${i}`, `s${i}`, `<p>${i}</p>`)) }], stats: parseVariationStats([{ step: 1, variations: Array.from({ length: 110 }, (_, i) => ({ variation: `V${i}`, sent: 100, pos_reply: 1 + (i % 3) })) }]) };
  const big = planMultiWinners(base, [base, many], "keep");
  eq("past the per-step limit the weakest are left out", [big.kept, big.overLimit, big.steps[0].variations.at(-1).variation], [104, 7, "CZ"]);
}

console.log("--- (Previous Winner) on the best variant");
{
  eq("added after the name", withWinnerMark("Permission-ask + without", true), "Permission-ask + without (Previous Winner)");
  eq("no name: the mark alone", withWinnerMark("", true), WINNER_MARK);
  eq("not stacked on a clone of a clone", withWinnerMark("Angle (Previous Winner)", true), "Angle (Previous Winner)");
  eq("taken off one that isn't the winner this time", withWinnerMark("Angle (previous winner)", false), "Angle");
  eq("the bar: the most positive replies, when more than one", [winnerBar([3, 2, 1]), winnerBar([2, 2, 1]), winnerBar([1, 1, 1]), winnerBar([])], [3, 2, null, null]);
  const v = (variation, name) => ({ variation, subject: variation, preheader: "", name, body: `<p>${variation}</p>` });
  const seq = [{ step: 1, wait_time: 0, variations: [v("A", "Angle A"), v("B", "Angle B"), v("C", ""), v("D", "Old (Previous Winner)")] }];
  const at = (rows) => parseVariationStats([{ step: 1, variations: rows.map(([variation, pos]) => ({ variation, sent: 100, pos_reply: pos })) }]);
  const names = (p) => p.steps[0].variations.map((x) => [x.variation, x.name]);
  eq("3 and 2: only the 3 is marked; an old mark comes off", names(planWinners(seq, at([["A", 3], ["B", 2], ["C", 0], ["D", 1]]))), [["A", "Angle A (Previous Winner)"], ["B", "Angle B"], ["C", "Old"]]);
  eq("the winner goes first as A, the rest after in their own order", names(planWinners(seq, at([["A", 1], ["B", 2], ["C", 0], ["D", 3]]))), [["A", "Old (Previous Winner)"], ["B", "Angle A"], ["C", "Angle B"]]);
  eq("…its body comes with it", planWinners(seq, at([["A", 1], ["B", 2], ["C", 0], ["D", 3]])).steps[0].variations[0].body, "<p>D</p>");
  eq("…and the rows say their new letter", planWinners(seq, at([["A", 1], ["B", 2], ["C", 0], ["D", 3]])).rows.map((r) => [r.variation, r.newLetter ?? null]), [["A", "B"], ["B", "C"], ["C", null], ["D", "A"]]);
  eq("…and the plan says which", planWinners(seq, at([["A", 3], ["B", 2], ["C", 0], ["D", 1]])).marked, ["A"]);
  eq("two tied at 2: both marked, both first", names(planWinners(seq, at([["A", 1], ["B", 2], ["C", 0], ["D", 2]]))), [["A", "Angle B (Previous Winner)"], ["B", "Old (Previous Winner)"], ["C", "Angle A"]]);
  eq("…and the plan names them by their new letters", planWinners(seq, at([["A", 1], ["B", 2], ["C", 0], ["D", 2]])).marked, ["A", "B"]);
  eq("none marked: letters as they were", names(planWinners(seq, at([["A", 0], ["B", 1], ["C", 0], ["D", 1]]))), [["B", "Angle B"], ["D", "Old"]]);
  eq("all at one positive reply: none marked", planWinners(seq, at([["A", 1], ["B", 1], ["C", 0], ["D", 0]])).marked, []);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
