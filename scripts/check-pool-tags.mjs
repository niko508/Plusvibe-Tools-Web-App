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
const { POOLS, POOL_TAG_SET, poolOfInbox, planPools, emptyPoolCounts, describePools, otherPool } = P;

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
eq("each pool has exactly one other", [otherPool("google"), otherPool("microsoft")], ["microsoft", "google"]);

// --- planning a workspace --------------------------------------------------------
console.log("--- the plan");
const plan = planPools(
  [inbox("a", G), inbox("b", M), inbox("c", G), inbox("d", R)],
  TAGS
);
eq("each provider's mailboxes get their own pool's tag",
  [...plan.assignments.entries()].map(([id, ids]) => [id, ids]), [["tg", ["a", "c"]], ["tm", ["b"]]]);
eq("…with nothing to take off", [...plan.removals.entries()], []);
eq("…counted by pool", plan.counts, { google: 2, microsoft: 1, removed: 0, ok: 0, noPool: 1 });
eq("…and each row says what it is",
  plan.rows.map((r) => [r.id, r.decision, r.pool ?? null]),
  [["a", "assign", "google"], ["b", "assign", "microsoft"], ["c", "assign", "google"], ["d", "no-pool", null]]);

// The point of the pass: a pool that holds the other provider's mailboxes is
// worth nothing, so the wrong tag comes OFF.
console.log("--- the wrong pool");
const wrong = planPools(
  [
    inbox("already-right", G, ["tg"]),
    // A Microsoft mailbox sitting in the Google pool: exactly what went wrong.
    inbox("in-wrong-pool", M, ["tg"]),
    // In both: the right one stays, the wrong one goes.
    inbox("in-both", G, ["tg", "tm"]),
    inbox("untagged", G, ["other-tag"]),
  ],
  TAGS
);
const decide = (id) => wrong.rows.find((r) => r.id === id).decision;
eq("an inbox already in the right pool is left alone", decide("already-right"), "ok");
eq("…one in the wrong pool gets its own tag and loses the other's", decide("in-wrong-pool"), "fix");
eq("…one carrying both keeps its own and loses the other's", decide("in-both"), "remove");
eq("…and an unrelated tag is no reason to skip", decide("untagged"), "assign");
eq("only the two that need it are assigned",
  [...wrong.assignments.entries()], [["tm", ["in-wrong-pool"]], ["tg", ["untagged"]]]);
eq("…and the other pool's tag comes off exactly the two carrying it wrongly",
  [...wrong.removals.entries()], [["tg", ["in-wrong-pool"]], ["tm", ["in-both"]]]);
eq("…counted", wrong.counts, { google: 1, microsoft: 1, removed: 2, ok: 1, noPool: 0 });
// Everything else an inbox carries is none of this pass's business.
eq("the row names both tags it touches",
  (({ tag, removes }) => [tag, removes])(wrong.rows.find((r) => r.id === "in-wrong-pool")),
  ["microsoft-pool", "google-pool"]);
// An inbox on neither provider is left exactly as it is, pool tag and all:
// there is no way to tell a mistake from a decision there.
eq("a pool tag on a mailbox from neither provider is left alone",
  (() => { const p = planPools([inbox("smtp", R, ["tg"])], TAGS); return [p.rows[0].decision, [...p.removals.entries()], p.counts.noPool]; })(),
  ["no-pool", [], 1]);

// --- the awkward cases -------------------------------------------------------------
console.log("--- the awkward cases");
eq("no inboxes is an empty plan, not an error",
  [planPools([], TAGS).counts, [...planPools([], TAGS).assignments.keys()], [...planPools([], TAGS).removals.keys()]],
  [emptyPoolCounts(), [], []]);
// Tag ids are per workspace, so a set that is missing one must not silently
// assign nothing and report it as done.
eq("with only the Google tag, Microsoft mailboxes are counted as having no pool",
  planPools([inbox("a", G), inbox("b", M)], [{ name: "google-pool", id: "tg" }]).counts,
  { google: 1, microsoft: 0, removed: 0, ok: 0, noPool: 1 });
eq("…and nothing is assigned for them",
  [...planPools([inbox("b", M)], [{ name: "google-pool", id: "tg" }]).assignments.keys()], []);
// …and nothing is taken off them either: without the Microsoft tag there is
// no pool to move them to, and stripping google-pool would leave them nowhere.
eq("…nor taken off them",
  [...planPools([inbox("b", M, ["tg"])], [{ name: "google-pool", id: "tg" }]).removals.entries()], []);
eq("an inbox with no id is skipped entirely", planPools([{ id: "", email: "x@y.com", provider: G, tags: [] }], TAGS).rows, []);
eq("tag names are matched whatever case they are stored in",
  planPools([inbox("a", G)], [{ name: "  Google-Pool ", id: "tg" }]).counts.google, 1);
// One tag under both names would otherwise be assigned and unassigned at once.
eq("a workspace where both names resolve to one tag never fights itself",
  (() => {
    const p = planPools([inbox("a", G, ["t1"])], [{ name: "google-pool", id: "t1" }, { name: "microsoft-pool", id: "t1" }]);
    return [p.rows[0].decision, [...p.removals.entries()], [...p.assignments.entries()]];
  })(),
  ["ok", [], []]);

// --- what it says afterwards ----------------------------------------------------------
console.log("--- the summary");
eq("a full run reads as a sentence",
  describePools({ google: 12, microsoft: 40, removed: 3, ok: 6, noPool: 2 }),
  "12 google-pool · 40 microsoft-pool · 3 wrong tag removed · 6 already right · 2 on neither provider");
eq("…and one with nothing to do says so", describePools(emptyPoolCounts()), "nothing to tag");
eq("…leaving out the parts that are zero",
  describePools({ google: 3, microsoft: 0, removed: 0, ok: 0, noPool: 0 }), "3 google-pool");

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
