// Unit checks for the Add Signatures tag filter: which inboxes a filter
// selects, and the counts shown beside each tag.
//
// Imports the REAL module through the TS loader, so a passing run says
// something about the code that ships rather than about a copy of it.
//
//   node scripts/check-signature-tags.mjs

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

const f = await importTs("@/app/tools/add-signatures/filter");
const { UNTAGGED, groupInboxes, countByTag, matchesTagFilter } = f;

const MASTER = new Set(["T_MASTER"]);
const none = new Set();

// A workspace mid-scale-up: an old batch, a new batch, one person spanning
// both, an untagged straggler, a nameless inbox, and a Master Inbox.
const INBOXES = [
  { id: "1", email: "ana@a.com", first_name: "Ana", last_name: "Diaz", tags: ["T_OLD"] },
  { id: "2", email: "ana@b.com", first_name: "Ana", last_name: "Diaz", tags: ["T_NEW"] },
  { id: "3", email: "bo@a.com", first_name: "Bo", last_name: "Lin", tags: ["T_NEW"] },
  { id: "4", email: "bo@b.com", first_name: "Bo", last_name: "Lin", tags: ["T_NEW", "T_OLD"] },
  { id: "5", email: "cy@a.com", first_name: "Cy", last_name: "Ray", tags: [] },
  { id: "6", email: "noname@a.com", first_name: "", last_name: "", tags: ["T_NEW"] },
  { id: "7", email: "master@a.com", first_name: "Zed", last_name: "Q", tags: ["T_MASTER"] },
];

// --- no filter: the behaviour the tool had before tags were selectable ------

const all = groupInboxes(INBOXES, { masterTagIds: MASTER, tagFilter: none });
eq("no filter takes every eligible inbox", all.matched, 5);
eq("…grouped into three people", all.groups.length, 3);
eq("…the Master Inbox is excluded", all.excludedMaster, 1);
eq("…the nameless one is skipped", all.skippedNoName, 1);
eq("…and nothing is filtered out", all.filteredOut, 0);
eq("total counts every inbox loaded", all.total, 7);

// --- the case this was built for: update only the new batch -----------------

const newOnly = groupInboxes(INBOXES, {
  masterTagIds: MASTER,
  tagFilter: new Set(["T_NEW"]),
});
eq("one tag selects only its inboxes", newOnly.matched, 3);
eq("…the rest are reported as filtered out", newOnly.filteredOut, 2);
eq("…the nameless one is still skipped, not counted", newOnly.skippedNoName, 1);

// Ana has one old inbox and one new one. Filtering to the new batch must update
// only her new inbox — not both, and not neither.
const ana = newOnly.groups.find((g) => g.first === "Ana");
eq("a person spanning both batches keeps only the matching inbox", ana.ids, ["2"]);
eq("…and is still in the run", newOnly.groups.length, 2);

// --- multiple tags are OR, not AND ------------------------------------------

const both = groupInboxes(INBOXES, {
  masterTagIds: MASTER,
  tagFilter: new Set(["T_NEW", "T_OLD"]),
});
// AND would give 1 (only inbox 4 carries both) and quietly skip the rest.
eq("two tags include an inbox carrying either", both.matched, 4);
eq("…which is more than either tag alone", both.matched > newOnly.matched, true);

// --- untagged ---------------------------------------------------------------

const untagged = groupInboxes(INBOXES, {
  masterTagIds: MASTER,
  tagFilter: new Set([UNTAGGED]),
});
eq("the No-tags chip selects only untagged inboxes", untagged.matched, 1);
eq("…which is Cy", untagged.groups[0].first, "Cy");

const mixed = groupInboxes(INBOXES, {
  masterTagIds: MASTER,
  tagFilter: new Set([UNTAGGED, "T_OLD"]),
});
eq("No-tags combines with a real tag", mixed.matched, 3);

// --- Master Inbox is never selectable ---------------------------------------

// Even asked for by id, a Master Inbox must not come back — the exclusion is a
// safety rule, not a preference the filter can override.
const askMaster = groupInboxes(INBOXES, {
  masterTagIds: MASTER,
  tagFilter: new Set(["T_MASTER"]),
});
eq("selecting the Master tag still excludes those inboxes", askMaster.matched, 0);
eq("…and reports them as excluded, not filtered", askMaster.excludedMaster, 1);

// --- matchesTagFilter on its own --------------------------------------------

eq("an empty filter matches anything", matchesTagFilter({ tags: ["X"] }, none), true);
eq("an inbox with no tags field is untagged", matchesTagFilter({}, new Set([UNTAGGED])), true);
eq("…and does not match a real tag", matchesTagFilter({}, new Set(["T_NEW"])), false);
eq(
  "an inbox with tags does not match No-tags",
  matchesTagFilter({ tags: ["T_NEW"] }, new Set([UNTAGGED])),
  false
);

// --- the counts shown on the chips ------------------------------------------

const c = countByTag(INBOXES, MASTER);
// The chip numbers must equal what a run with that chip selected would update,
// or they shrink the moment Apply is pressed.
eq("eligible excludes the Master Inbox and the nameless one", c.eligible, 5);
eq("eligible equals an unfiltered run", c.eligible, all.matched);
eq("T_NEW count excludes the nameless inbox", c.byTag.get("T_NEW"), 3);
eq("…and equals a T_NEW run", c.byTag.get("T_NEW"), newOnly.matched);
eq("T_OLD count", c.byTag.get("T_OLD"), 2);
eq("untagged count", c.untagged, 1);
eq("the Master tag counts nothing", c.byTag.get("T_MASTER"), undefined);
// The chips are an OR, so the per-tag numbers overlap rather than summing to
// the workspace size — inbox 4 is counted under both tags.
eq(
  "counts overlap rather than partition",
  (c.byTag.get("T_NEW") ?? 0) + (c.byTag.get("T_OLD") ?? 0) + c.untagged > c.eligible,
  true
);

// A duplicated tag on one inbox must not inflate its count.
const dupe = countByTag(
  [{ id: "9", email: "d@a.com", first_name: "D", tags: ["T_NEW", "T_NEW"] }],
  MASTER
);
eq("a repeated tag counts once", dupe.byTag.get("T_NEW"), 1);

// Every chip's number, checked against a real run with that chip selected.
for (const tag of ["T_NEW", "T_OLD"]) {
  const run = groupInboxes(INBOXES, {
    masterTagIds: MASTER,
    tagFilter: new Set([tag]),
  });
  eq(`the ${tag} chip promises what it delivers`, c.byTag.get(tag) ?? 0, run.matched);
}
eq("the No-tags chip promises what it delivers", c.untagged, untagged.matched);

// --- an empty workspace -----------------------------------------------------

const empty = groupInboxes([], { masterTagIds: MASTER, tagFilter: none });
eq("no inboxes gives no groups", empty.groups.length, 0);
eq("…and no matches", empty.matched, 0);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
