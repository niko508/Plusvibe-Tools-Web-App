// Unit checks for tagging inboxes by provider: which pool an inbox belongs to,
// which ones are skipped, and what the run reports. Imports the REAL modules.
//
//   node scripts/check-pool-tags.mjs

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

const P = await importTs("@/lib/tags/pool-tags");
const POOLS_MOD = await importTs("@/lib/campaign-types/pools");
const { POOLS, POOL_TAG_SET, poolOfInbox, planPools, emptyPoolCounts, describePools } = P;

const G = "GOOGLE_WORKSPACE", M = "MICROSOFT365", R = "REGULAR_ACCOUNT";
/** The workspace's own two tags, as the job hands them over. */
const TAGS = [
  { name: "google-pool", id: "tg" },
  { name: "microsoft-pool", id: "tm" },
];
const inbox = (id, provider, tags = []) => ({ id, email: `${id}@x.com`, provider, tags });

// --- the two pools -------------------------------------------------------------
console.log("--- the pools");
eq("two pools", POOLS, ["google", "microsoft"]);
// The names are Create All Campaign Types', imported rather than restated —
// a campaign and the mailboxes that send it have to read the same.
eq("…named as the campaign tool names them",
  POOL_TAG_SET.map((t) => t.name), [POOLS_MOD.POOL_TAGS.google.name, POOLS_MOD.POOL_TAGS.microsoft.name]);
eq("…which is google-pool and microsoft-pool", POOL_TAG_SET.map((t) => t.name), ["google-pool", "microsoft-pool"]);
eq("…each with a colour, so a missing tag can be created", POOL_TAG_SET.every((t) => !!t.color), true);

eq("a Google mailbox is in the Google pool", poolOfInbox(G), "google");
eq("a Microsoft one is in the Microsoft pool", poolOfInbox(M), "microsoft");
// There is no third pool, so anything else gets none rather than a guess.
eq("anything else is in neither", [poolOfInbox(R), poolOfInbox(""), poolOfInbox(undefined)], [null, null, null]);

// --- planning a workspace --------------------------------------------------------
console.log("--- the plan");
const plan = planPools(
  [inbox("a", G), inbox("b", M), inbox("c", G), inbox("d", R)],
  TAGS
);
eq("each provider's mailboxes get their own pool's tag",
  [...plan.assignments.entries()].map(([id, ids]) => [id, ids]), [["tg", ["a", "c"]], ["tm", ["b"]]]);
eq("…counted by pool", plan.counts, { google: 2, microsoft: 1, has: 0, noPool: 1 });
eq("…and each row says what it is",
  plan.rows.map((r) => [r.id, r.decision, r.pool ?? null]),
  [["a", "assign", "google"], ["b", "assign", "microsoft"], ["c", "assign", "google"], ["d", "no-pool", null]]);

// The skip rule: EITHER tag counts, not only the matching one.
console.log("--- what is skipped");
const skipped = planPools(
  [
    inbox("already-right", G, ["tg"]),
    // Moved to the other pool by hand: putting it back would undo a decision.
    inbox("moved-by-hand", G, ["tm"]),
    inbox("untagged", G, ["other-tag"]),
  ],
  TAGS
);
eq("an inbox with its own pool tag is skipped",
  skipped.rows.find((r) => r.id === "already-right").decision, "has");
eq("…and so is one carrying the OTHER pool's tag",
  skipped.rows.find((r) => r.id === "moved-by-hand").decision, "has");
eq("…while an unrelated tag is no reason to skip",
  skipped.rows.find((r) => r.id === "untagged").decision, "assign");
eq("…so only the untagged one is assigned", [...skipped.assignments.values()], [["untagged"]]);
eq("…and two are counted as already sorted", skipped.counts, { google: 1, microsoft: 0, has: 2, noPool: 0 });

// --- the awkward cases -------------------------------------------------------------
console.log("--- the awkward cases");
eq("no inboxes is an empty plan, not an error",
  [planPools([], TAGS).counts, [...planPools([], TAGS).assignments.keys()]], [emptyPoolCounts(), []]);
// Tag ids are per workspace, so a set that is missing one must not silently
// assign nothing and report it as done.
eq("with only the Google tag, Microsoft mailboxes are counted as having no pool",
  planPools([inbox("a", G), inbox("b", M)], [{ name: "google-pool", id: "tg" }]).counts,
  { google: 1, microsoft: 0, has: 0, noPool: 1 });
eq("…and nothing is assigned for them",
  [...planPools([inbox("b", M)], [{ name: "google-pool", id: "tg" }]).assignments.keys()], []);
eq("an inbox with no id is skipped entirely", planPools([{ id: "", email: "x@y.com", provider: G, tags: [] }], TAGS).rows, []);
eq("tag names are matched whatever case they are stored in",
  planPools([inbox("a", G)], [{ name: "  Google-Pool ", id: "tg" }]).counts.google, 1);

// --- what it says afterwards ----------------------------------------------------------
console.log("--- the summary");
eq("a full run reads as a sentence",
  describePools({ google: 12, microsoft: 40, has: 6, noPool: 2 }),
  "12 google-pool · 40 microsoft-pool · 6 already tagged · 2 on neither provider");
eq("…and one with nothing to do says so", describePools(emptyPoolCounts()), "nothing to tag");
eq("…leaving out the parts that are zero",
  describePools({ google: 3, microsoft: 0, has: 0, noPool: 0 }), "3 google-pool");

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
