// Unit checks for which existing campaigns Create All Campaign Types is willing
// to adopt under a name it wants.
//
// Imports the REAL module through the TS loader.
//
//   node scripts/check-reuse-index.mjs

import { importTs } from "./ts-loader.mjs";

let failures = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`PASS  ${label}`);
  else {
    failures++;
    console.log(
      `FAIL  ${label}\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`
    );
  }
};

const m = await importTs("@/lib/campaign-types/match");
const { buildReuseIndex, isArchived, normalizeName } = m;

// --- isArchived -------------------------------------------------------------

eq("ARCHIVED is archived", isArchived({ status: "ARCHIVED" }), true);
eq("lowercase counts too", isArchived({ status: "archived" }), true);
eq("whitespace is ignored", isArchived({ status: "  Archived  " }), true);
eq("ACTIVE is not", isArchived({ status: "ACTIVE" }), false);
eq("DRAFTED is not", isArchived({ status: "DRAFTED" }), false);
eq("PAUSED is not", isArchived({ status: "PAUSED" }), false);
eq("COMPLETED is not", isArchived({ status: "COMPLETED" }), false);
// Only ARCHIVED is excluded. Paused and completed campaigns still take leads,
// so excluding them would create needless duplicate campaigns.
eq("a missing status is not archived", isArchived({}), false);

// --- the bug this fixes -----------------------------------------------------

const NAME = "🔵 Evergreen (August)";

// Exactly the reported case: the only campaign holding the name is archived.
// Adopting it reports "reused" and then dies on the first lead with "Campaign
// is archived", having moved nothing.
const onlyArchived = buildReuseIndex([
  { id: "src", name: "Evergreen (August)", status: "ACTIVE" },
  { id: "old", name: NAME, status: "ARCHIVED" },
]);
eq(
  "an archived campaign does not claim its name",
  onlyArchived.get(normalizeName(NAME)),
  undefined
);
eq("…so the live source is still indexed", onlyArchived.get("evergreen (august)"), "src");

// --- normal reuse still works ----------------------------------------------

const live = buildReuseIndex([{ id: "c1", name: NAME, status: "ACTIVE" }]);
eq("a live campaign claims its name", live.get(normalizeName(NAME)), "c1");

for (const status of ["DRAFTED", "PAUSED", "COMPLETED", ""]) {
  const idx = buildReuseIndex([{ id: "c1", name: NAME, status }]);
  eq(`a ${status || "(blank)"} campaign is still reused`, idx.get(normalizeName(NAME)), "c1");
}

// A live campaign must win over an archived one sharing the name, whichever
// order they arrive in — otherwise re-running after a partial job would make a
// second live copy instead of adopting the one it already made.
const archivedFirst = buildReuseIndex([
  { id: "old", name: NAME, status: "ARCHIVED" },
  { id: "new", name: NAME, status: "ACTIVE" },
]);
eq("archived first: the live one wins", archivedFirst.get(normalizeName(NAME)), "new");

const liveFirst = buildReuseIndex([
  { id: "new", name: NAME, status: "ACTIVE" },
  { id: "old", name: NAME, status: "ARCHIVED" },
]);
eq("live first: the live one wins", liveFirst.get(normalizeName(NAME)), "new");

// Two archived under the same name is still a free name.
eq(
  "two archived leave the name free",
  buildReuseIndex([
    { id: "a", name: NAME, status: "ARCHIVED" },
    { id: "b", name: NAME, status: "ARCHIVED" },
  ]).get(normalizeName(NAME)),
  undefined
);

// --- the rules that were already there ---------------------------------------

eq(
  "sub-sequences never claim a name",
  buildReuseIndex([
    { id: "s", name: NAME, status: "ACTIVE", campaignType: "subseq" },
  ]).get(normalizeName(NAME)),
  undefined
);
eq(
  "the first live one wins among duplicates",
  buildReuseIndex([
    { id: "first", name: NAME, status: "ACTIVE" },
    { id: "second", name: NAME, status: "PAUSED" },
  ]).get(normalizeName(NAME)),
  "first"
);
eq(
  "case and spacing differences still match",
  buildReuseIndex([{ id: "c1", name: "🔵  EVERGREEN (August)  ", status: "ACTIVE" }]).get(
    normalizeName(NAME)
  ),
  "c1"
);
eq("a campaign with no id is skipped", buildReuseIndex([{ id: "", name: NAME }]).size, 0);
eq("an empty workspace indexes nothing", buildReuseIndex([]).size, 0);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
