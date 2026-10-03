// Unit checks for Copy Campaign to Other Workspace: what the run will do, and
// what stops it. Imports the REAL module.
//
//   node scripts/check-copy-campaign.mjs

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
const check = (label, ok, detail = "") => {
  if (ok) console.log(`PASS  ${label}`);
  else {
    failures++;
    console.log(`FAIL  ${label}${detail ? `\n   ${detail}` : ""}`);
  }
};

const {
  defaultName,
  planProblems,
  planWarnings,
  shapeOf,
  countVariations,
  compareShapes,
  describePlan,
  MAX_NAME,
} = await importTs("@/lib/copy-campaign/plan");

const full = {
  sourceWorkspaceId: "ws1",
  sourceCampaignId: "c1",
  destWorkspaceId: "ws2",
  destCampaignId: "c2",
  name: "Roof Repair (September)",
};

// --- What stops the run -----------------------------------------------------
eq("a complete selection has nothing wrong with it", planProblems(full), []);
eq(
  "every missing piece is named",
  planProblems({}),
  [
    "Pick the source workspace.",
    "Pick the campaign to copy from.",
    "Pick the destination workspace.",
    "Pick the destination campaign to take the settings from.",
    "Give the new campaign a name.",
  ]
);
eq(
  "a blank name is not a name",
  planProblems({ ...full, name: "   " }),
  ["Give the new campaign a name."]
);
eq(
  "an over-long name is refused",
  planProblems({ ...full, name: "x".repeat(MAX_NAME + 1) }),
  [`The name is too long (max ${MAX_NAME} characters).`]
);
eq(
  "a source with no steps has nothing to copy",
  planProblems(full, { sourceSteps: 0 }),
  ["The source campaign has no sequence steps to copy."]
);
eq(
  "…while a source that has steps is fine",
  planProblems(full, { sourceSteps: 3 }),
  []
);

// --- What is worth saying but does not block --------------------------------
eq("copying between two workspaces says nothing", planWarnings(full), []);
eq(
  "the same workspace both sides is worth a word",
  planWarnings({ ...full, destWorkspaceId: "ws1" }),
  ["Both workspaces are the same, so the copy is created alongside the original."]
);
check(
  "…and the same campaign both sides is worth two",
  planWarnings({ ...full, destWorkspaceId: "ws1", destCampaignId: "c1" }).length === 2
);

// --- The shape that has to survive the copy ---------------------------------
const steps = [
  { step: 2, variations: ["a"] },
  { step: 1, variations: ["a", "b", "c"] },
];
eq("steps are reduced to counts, in order", shapeOf(steps), [
  { step: 1, variations: 3 },
  { step: 2, variations: 1 },
]);
eq("…and add up", countVariations(shapeOf(steps)), 4);

const expected = shapeOf(steps);
eq("a copy that matches is verified", compareShapes(expected, expected), {
  ok: true,
  problems: [],
});
eq(
  "a missing step is named",
  compareShapes(expected, [{ step: 1, variations: 3 }]),
  {
    ok: false,
    problems: ["Expected 2 steps on the copy but found 1.", "Step 2 is missing from the copy."],
  }
);
eq(
  "a short step says what it should have had",
  compareShapes(expected, [
    { step: 1, variations: 2 },
    { step: 2, variations: 1 },
  ]),
  { ok: false, problems: ["Step 1 should have 3 variations but has 2."] }
);
check(
  "an extra step on the copy is caught too",
  !compareShapes(expected, [...expected, { step: 3, variations: 1 }]).ok
);

// --- Naming and describing --------------------------------------------------
eq("the copy is named after the source", defaultName("  Roof Repair  "), "Roof Repair");
eq("…and a monstrous name is cut to size", defaultName("x".repeat(500)).length, MAX_NAME);

eq(
  "the plan says which campaign gives what",
  describePlan({
    sourceCampaign: "Roof Repair",
    destCampaign: "Template A",
    destWorkspace: "Client B",
    name: "Roof Repair",
    steps: 3,
    variations: 7,
    subsequences: true,
  }),
  '"Template A" will be duplicated inside Client B as "Roof Repair", carrying its settings, schedule, sender accounts and sub-sequences. ' +
    'The new campaign\'s own copy is then replaced with 3 steps and 7 variations from "Roof Repair".'
);
check(
  "…and drops the sub-sequences when they are not coming",
  !describePlan({
    sourceCampaign: "A",
    destCampaign: "B",
    destWorkspace: "C",
    name: "A",
    steps: 1,
    variations: 1,
    subsequences: false,
  }).includes("sub-sequences")
);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
