// Unit checks for Fix Allocation: the part each picked campaign plays, and
// which leads go to it. Imports the REAL module.
//
//   node scripts/check-allocate.mjs

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

const {
  roleOfName, hasBlue, classifyDestinations, planAllocation, describeAllocation,
  ALLOC_ROLES, ALLOC_ROLE_LABELS,
} = await importTs("@/lib/campaign-types/allocate");

// --- the part a campaign plays ------------------------------------------------
console.log("--- roles, read off the name");
eq("the six parts", ALLOC_ROLES, ["source", "blue", "optOut", "blueOptOut", "signature", "blueSignature"]);
eq("a plain yellow campaign takes the Google side", roleOfName("🟡 Apps (August)"), "source");
eq("…a blue one the Microsoft side", roleOfName("🔵 Apps (August)"), "blue");
eq("…opt out, both sides", [roleOfName("🟡 Apps - Opt Out (August)"), roleOfName("🔵 Apps - Opt Out (August)")], ["optOut", "blueOptOut"]);
eq("…signature, both sides", [roleOfName("🟡 Apps - Signature (August)"), roleOfName("🔵 Apps - Signature (August)")], ["signature", "blueSignature"]);
// Names without a circle are the older convention; they are still the plain one.
eq("a name with no circle at all is the plain one", roleOfName("Apps (August)"), "source");
eq("…and still reads its markers", roleOfName("Apps - Opt Out (August)"), "optOut");
eq("the blue circle is spotted with or without the variation selector",
  [hasBlue("🔵 X"), hasBlue("🔵️ X"), hasBlue("🟡 X"), hasBlue("X")], [true, true, false, false]);

// --- picking the destinations ----------------------------------------------------
console.log("--- the picked campaigns");
const FAMILY = [
  { campaignId: "y", campaignName: "🟡 Apps (August)" },
  { campaignId: "b", campaignName: "🔵 Apps (August)" },
  { campaignId: "yo", campaignName: "🟡 Apps - Opt Out (August)" },
  { campaignId: "bo", campaignName: "🔵 Apps - Opt Out (August)" },
];
const fam = classifyDestinations(FAMILY);
eq("each pick gets its part", fam.destinations.map((d) => d.role), ["source", "blue", "optOut", "blueOptOut"]);
eq("…with nothing to complain about", fam.problems, []);
// Two campaigns claiming one part is refused, not resolved: there is no
// telling which was meant, and half a bucket would go to the wrong one.
const clash = classifyDestinations([...FAMILY, { campaignId: "b2", campaignName: "🔵 Apps (August) copy" }]);
eq("two campaigns for one part is a problem", clash.problems.length, 1);
eq("…naming both", /both take the Microsoft leads/.test(clash.problems[0]), true);
eq("…and the second is left out", clash.destinations.map((d) => d.campaignId), ["y", "b", "yo", "bo"]);
eq("the same campaign twice is just the once", classifyDestinations([FAMILY[0], FAMILY[0]]).destinations.length, 1);

// --- placing the leads --------------------------------------------------------------
console.log("--- where the leads go");
const lead = (id, segment, blue) => ({ lead: id, segment, blue });
const LEADS = [
  ...Array.from({ length: 4 }, (_, i) => lead(`ms${i}`, "app", true)),
  ...Array.from({ length: 3 }, (_, i) => lead(`g${i}`, "app", false)),
  ...Array.from({ length: 3 }, (_, i) => lead(`x${i}`, "local", false)),
];
const plan = planAllocation(LEADS, "app", fam.destinations);
eq("only the segment asked for is placed", [plan.matched, plan.skipped, plan.stranded], [7, 3, 0]);
eq("…every one of them placed", plan.moves.reduce((n, m) => n + m.leads.length, 0), 7);
eq("…Microsoft to the blue side, halved for opt-out",
  plan.moves.filter((m) => m.role.startsWith("blue")).map((m) => [m.role, m.leads]),
  [["blue", ["ms0", "ms1"]], ["blueOptOut", ["ms2", "ms3"]]]);
eq("…and the rest to the other side, the odd one staying off opt-out",
  plan.moves.filter((m) => !m.role.startsWith("blue")).map((m) => [m.role, m.leads]),
  [["source", ["g0", "g1"]], ["optOut", ["g2"]]]);
// Segment matching is the same everywhere: case and edges do not count.
eq("case and space do not stop a match",
  planAllocation([lead("a", " APP ", false)], "app", fam.destinations).matched, 1);
eq("no segment asked for places nothing", planAllocation(LEADS, "  ", fam.destinations).matched, 0);

// --- when a part was not picked ---------------------------------------------------------
console.log("--- a part left unpicked");
// A Microsoft lead does not belong in a Google campaign just because that is
// the one that was picked: it stays where it is and is counted.
const noBlue = classifyDestinations([FAMILY[0], FAMILY[2]]).destinations;
const msStuck = planAllocation(LEADS, "app", noBlue);
eq("Microsoft leads with no blue campaign stay put", msStuck.stranded, 4);
eq("…while the others are still placed", msStuck.moves.reduce((n, m) => n + m.leads.length, 0), 3);
eq("…and none of them went to a Google campaign",
  msStuck.moves.every((m) => !m.leads.some((l) => String(l).startsWith("ms"))), true);
// The plain campaign is the one a normal run never has to move into, because
// the leads are already there. Here they are not.
const noPlain = classifyDestinations([FAMILY[1], FAMILY[2], FAMILY[3]]).destinations;
const plainStuck = planAllocation(LEADS, "app", noPlain);
eq("without the plain campaign its share stays put too", plainStuck.stranded, 2);
eq("…the opt-out share still moves", plainStuck.moves.find((m) => m.role === "optOut").leads, ["g2"]);
eq("…and every Microsoft lead still moves",
  plainStuck.moves.filter((m) => m.role.startsWith("blue")).reduce((n, m) => n + m.leads.length, 0), 4);
eq("nothing picked at all places nothing, and loses nothing",
  (({ matched, stranded, moves }) => [matched, stranded, moves.length])(planAllocation(LEADS, "app", [])),
  [7, 7, 0]);
eq("no leads is an empty plan, not an error",
  (({ matched, skipped, stranded, moves }) => [matched, skipped, stranded, moves.length])(planAllocation([], "app", fam.destinations)),
  [0, 0, 0, 0]);

// --- what it says -------------------------------------------------------------------------
console.log("--- the summary");
eq("a plan reads as a sentence", describeAllocation(plan),
  "2 to 🔵 Apps (August) · 2 to 🔵 Apps - Opt Out (August) · 2 to 🟡 Apps (August) · 1 to 🟡 Apps - Opt Out (August)");
eq("…and an empty one says so", describeAllocation(planAllocation([], "app", fam.destinations)), "nothing to move");
eq("every part has a label", ALLOC_ROLES.every((r) => !!ALLOC_ROLE_LABELS[r]), true);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
