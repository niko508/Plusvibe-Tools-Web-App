// Unit checks for Update Inbox & Campaign Tags: which inbox or campaign falls
// in which scope, rule validation, the per-workspace plan for both adding and
// removing, chunking, the after-the-fact check and the tag catalogue. Imports
// the REAL module.
//
//   node scripts/check-inbox-tags.mjs

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

const m = await importTs("@/lib/inbox-tags/plan");
const {
  bucketOf, inScope, inboxInScope, validateRule, prepareRules, countProviders, planRule, chunk, verifyTags,
  buildCatalog, describeRules, scopeLabel, scopesFor, levelNoun, isLevel, isTagAction,
  inboxTaggable, campaignTaggable, countBuckets, describeBuckets,
} = m;
const inboxes = (list) => list.map(inboxTaggable);

// --- which bucket an inbox is in ------------------------------------------------
eq("Google Workspace is google", bucketOf("GOOGLE_WORKSPACE"), "google");
eq("Microsoft 365 is microsoft", bucketOf("MICROSOFT365"), "microsoft");
eq("a plain account is other", bucketOf("REGULAR_ACCOUNT"), "other");
eq("no provider is other", bucketOf(undefined), "other");
eq("case doesn't matter", bucketOf("microsoft365"), "microsoft");
eq("'all' takes everything", [inboxInScope("all", "GOOGLE_WORKSPACE"), inboxInScope("all", undefined)], [true, true]);
eq("'google' takes only Google", [inboxInScope("google", "GOOGLE_WORKSPACE"), inboxInScope("google", "MICROSOFT365")], [true, false]);
eq("'other' takes what is neither", [inboxInScope("other", "REGULAR_ACCOUNT"), inboxInScope("other", "MICROSOFT365")], [true, false]);
eq("a bucket falls in its own scope and in 'all'", [inScope("active", "active"), inScope("all", "active"), inScope("paused", "active")], [true, true, false]);

// --- rules --------------------------------------------------------------------------
eq("a good rule has no problems", validateRule({ scope: "google", tagName: "Google", color: "#3B82F6" }), []);
eq("an unknown scope is a problem", validateRule({ scope: "yahoo", tagName: "x", color: "#000" })[0], "Pick which inboxes the tag goes on.");
eq("a blank name is a problem", validateRule({ scope: "all", tagName: " ", color: "#000" }), ["Give the tag a name."]);
eq("a bad colour is a problem", validateRule({ scope: "all", tagName: "x", color: "blue" }), ["The colour needs to be a hex code like #FF5733 or #F57."]);

const r = prepareRules([
  { scope: "all", tagName: " Client A ", color: "#f57" },
  { scope: "google", tagName: "Google", color: "#3B82F6" },
  { scope: "microsoft", tagName: "Microsoft", color: "#10B981" },
  { scope: "google", tagName: "google", color: "#000000" }, // repeat of row 1
  { scope: "microsoft", tagName: "Google", color: "#000000" }, // same tag, other scope — fine
  { scope: "all", tagName: "", color: "#000000" }, // problem
]);
eq("good rules come out trimmed and normalised", r.rules.map((x) => [x.scope, x.tagName, x.color]), [
  ["all", "Client A", "#FF5577"],
  ["google", "Google", "#3B82F6"],
  ["microsoft", "Microsoft", "#10B981"],
  ["microsoft", "Google", "#000000"],
]);
eq("a repeated scope+name keeps the first", r.duplicates, [3]);
eq("problem rows are reported by position", [...r.problems.keys()], [5]);

// --- the plan for one workspace ----------------------------------------------------------
const INBOXES = [
  { id: "a1", email: "a1@x.com", provider: "GOOGLE_WORKSPACE", tags: [] },
  { id: "a2", email: "a2@x.com", provider: "GOOGLE_WORKSPACE", tags: ["tG"] },        // already has it
  { id: "a3", email: "a3@x.com", provider: "MICROSOFT365", tags: ["tOld"] },
  { id: "a4", email: "a4@x.com", provider: "MICROSOFT365", tags: [] },
  { id: "a5", email: "a5@x.com", provider: "REGULAR_ACCOUNT", tags: ["tG"] },        // wrong bucket, has it anyway
  { id: "", email: "broken@x.com", provider: "GOOGLE_WORKSPACE", tags: [] },       // no id — can't be sent
];
eq("providers are counted", countProviders(INBOXES), { google: 3, microsoft: 2, other: 1 });
eq("google rule: sends the untagged Google inboxes only", planRule({ scope: "google", tagName: "G", color: "#000" }, "tG", inboxes(INBOXES)), { matched: 2, already: 1, toChange: ["a1"] });
eq("all rule: sends everything without the tag", planRule({ scope: "all", tagName: "G", color: "#000" }, "tG", inboxes(INBOXES)), { matched: 5, already: 2, toChange: ["a1", "a3", "a4"] });
eq("microsoft rule: an old tag doesn't count as having it", planRule({ scope: "microsoft", tagName: "M", color: "#000" }, "tM", inboxes(INBOXES)), { matched: 2, already: 0, toChange: ["a3", "a4"] });
eq("an empty workspace plans nothing", planRule({ scope: "all", tagName: "G", color: "#000" }, "tG", []), { matched: 0, already: 0, toChange: [] });

// --- removing: the same plan, the other way round -----------------------------------------
// "already" means "already the way the rule wants it", so when removing it
// counts the ones that never had the tag.
eq("removing sends only what carries the tag", planRule({ scope: "all", tagName: "G", color: "#000" }, "tG", inboxes(INBOXES), "remove"), { matched: 5, already: 3, toChange: ["a2", "a5"] });
eq("…inside a scope", planRule({ scope: "google", tagName: "G", color: "#000" }, "tG", inboxes(INBOXES), "remove"), { matched: 2, already: 1, toChange: ["a2"] });
eq("removing a tag nothing has sends nothing", planRule({ scope: "all", tagName: "Z", color: "#000" }, "tZ", inboxes(INBOXES), "remove"), { matched: 5, already: 5, toChange: [] });

// --- campaigns: the bucket is the status ---------------------------------------------------
const CAMPAIGNS = [
  { id: "c1", name: "Alpha", status: "ACTIVE", tags: ["tC"] },
  { id: "c2", name: "Bravo", status: "RUNNING", tags: [] },
  { id: "c3", name: "Charlie", status: "PAUSED", tags: [] },
  { id: "c4", name: "Delta", status: "DRAFTED", tags: ["tC"] },
  { id: "c5", name: "Echo", status: "COMPLETED", tags: [] },
  { id: "c6", name: "Foxtrot", status: "ARCHIVED", tags: [] },
].map(campaignTaggable);
eq("RUNNING counts as active", CAMPAIGNS.map((c) => c.bucket), ["active", "active", "paused", "draft", "completed", "archived"]);
eq("statuses are counted", countBuckets(CAMPAIGNS), { active: 2, paused: 1, draft: 1, completed: 1, archived: 1 });
eq("an active rule takes both active campaigns", planRule({ scope: "active", tagName: "C", color: "#000" }, "tC", CAMPAIGNS), { matched: 2, already: 1, toChange: ["c2"] });
eq("a completed rule takes the completed one", planRule({ scope: "completed", tagName: "C", color: "#000" }, "tC", CAMPAIGNS).toChange, ["c5"]);
eq("a draft rule leaves the draft that has it alone", planRule({ scope: "draft", tagName: "C", color: "#000" }, "tC", CAMPAIGNS), { matched: 1, already: 1, toChange: [] });
eq("removing on campaigns sends the tagged ones", planRule({ scope: "all", tagName: "C", color: "#000" }, "tC", CAMPAIGNS, "remove").toChange, ["c1", "c4"]);
// There is no archived scope, and "all" would take one: keeping archived
// campaigns out is the job's job, done as they are read.
eq("'all' would otherwise reach an archived campaign", planRule({ scope: "all", tagName: "C", color: "#000" }, "tC", CAMPAIGNS).matched, 6);
eq("scopes are per level", [scopesFor("inboxes").length, scopesFor("campaigns").map((s) => s.key)], [4, ["all", "active", "paused", "draft", "completed"]]);
eq("a campaign scope is not an inbox scope", validateRule({ scope: "active", tagName: "x", color: "#000" }, "inboxes")[0], "Pick which inboxes the tag goes on.");
eq("…and the other way round", validateRule({ scope: "google", tagName: "x", color: "#000" }, "campaigns")[0], "Pick which campaigns the tag goes on.");
eq("'all' works at both levels", [validateRule({ scope: "all", tagName: "x", color: "#000" }, "inboxes"), validateRule({ scope: "all", tagName: "x", color: "#000" }, "campaigns")], [[], []]);
eq("levels and actions are checked, not trusted", [isLevel("campaigns"), isLevel("Inboxes"), isTagAction("remove"), isTagAction("delete")], [true, false, true, false]);
eq("buckets read as a sentence", [describeBuckets("inboxes", { google: 3, microsoft: 2, other: 1 }), describeBuckets("campaigns", { active: 2, draft: 1 })], ["3 Google · 2 Microsoft · 1 Other", "2 Active · 1 Draft"]);
eq("a bucket with none is left out", describeBuckets("inboxes", { google: 3 }), "3 Google");

// --- chunks --------------------------------------------------------------------------------
eq("chunks of the given size", chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
eq("nothing → no chunks (no empty call)", chunk([], 2), []);
eq("default chunk is 100", chunk(Array.from({ length: 250 }, (_, i) => i)).map((c) => c.length), [100, 100, 50]);

// --- the check afterwards -------------------------------------------------------------------
const before = [
  { id: "a1", email: "a1@x.com", tags: [] },
  { id: "a3", email: "a3@x.com", tags: ["tOld"] },
];
const expected = new Map([["a1", ["tG"]], ["a3", ["tM"]]]);
eq("all good: nothing lost, new tags present", verifyTags(before, [
  { id: "a1", email: "a1@x.com", tags: ["tG"] },
  { id: "a3", email: "a3@x.com", tags: ["tOld", "tM"] },
], expected), { checked: 2, lostTags: [], missingTag: [] });
eq("a replaced tag list is caught", verifyTags(before, [
  { id: "a3", email: "a3@x.com", tags: ["tM"] }, // tOld gone
], expected), { checked: 1, lostTags: ["a3@x.com"], missingTag: [] });
eq("a tag that didn't arrive is caught", verifyTags(before, [
  { id: "a1", email: "a1@x.com", tags: [] },
], expected), { checked: 1, lostTags: [], missingTag: ["a1@x.com"] });
eq("inboxes not in the sample are ignored", verifyTags(before, [{ id: "zz", email: "zz@x.com", tags: [] }], expected).checked, 0);

// After a remove the tag going missing is the point, so the "lost a tag" check
// has to skip exactly the tags the job touched.
const hadBoth = [{ id: "a1", email: "a1@x.com", tags: ["tG", "tKeep"] }];
const removed = new Map([["a1", ["tG"]]]);
eq("a removed tag is not reported as lost", verifyTags(hadBoth, [{ id: "a1", email: "a1@x.com", tags: ["tKeep"] }], removed, "remove"), { checked: 1, lostTags: [], missingTag: [] });
eq("…a tag that survived the remove is caught", verifyTags(hadBoth, [{ id: "a1", email: "a1@x.com", tags: ["tG", "tKeep"] }], removed, "remove"), { checked: 1, lostTags: [], missingTag: ["a1@x.com"] });
eq("…and another tag going with it is caught", verifyTags(hadBoth, [{ id: "a1", email: "a1@x.com", tags: [] }], removed, "remove"), { checked: 1, lostTags: ["a1@x.com"], missingTag: [] });
eq("campaigns are named by name", verifyTags([{ id: "c1", name: "Alpha", tags: [] }], [{ id: "c1", name: "Alpha", tags: [] }], new Map([["c1", ["tC"]]])).missingTag, ["Alpha"]);

// --- the catalogue --------------------------------------------------------------------------
const cat = buildCatalog([
  [{ name: "Google", color: "#3B82F6" }, { name: "VIP", color: "#f57" }],
  [{ name: "google", color: "#000000" }, { name: "Microsoft", color: "#10B981" }],
  [{ name: "Google" }, { name: "Microsoft" }],
]);
eq("merged by name, case-insensitively, most common first", cat.map((t) => [t.name, t.count]), [["Google", 3], ["Microsoft", 2], ["VIP", 1]]);
eq("the first colour seen wins, normalised", cat.map((t) => t.color), ["#3B82F6", "#10B981", "#FF5577"]);
eq("a tag without a colour anywhere gets the fallback", buildCatalog([[{ name: "x" }]])[0].color, "#6B7280");
eq("…but a colour from a later workspace replaces the fallback", buildCatalog([[{ name: "x" }], [{ name: "X", color: "#abc" }]])[0].color, "#AABBCC");
eq("an empty read is an empty catalogue", buildCatalog([]), []);

// --- labels ----------------------------------------------------------------------------------
eq("the job label reads as rules", describeRules(r.rules.slice(0, 2)), "Add · All inboxes → Client A, Google inboxes → Google");
eq("…and says when it is taking tags off", describeRules(r.rules.slice(0, 1), "inboxes", "remove"), "Remove · All inboxes → Client A");
eq("…at the campaign level too", describeRules([{ scope: "active", tagName: "Client A", color: "#000" }], "campaigns", "remove"), "Remove · Active campaigns → Client A");
eq("scope labels", [scopeLabel("inboxes", "all"), scopeLabel("inboxes", "google"), scopeLabel("campaigns", "all"), scopeLabel("campaigns", "paused")], ["All inboxes", "Google inboxes", "All campaigns", "Paused campaigns"]);
eq("nouns for sentences", [levelNoun("inboxes"), levelNoun("inboxes", true), levelNoun("campaigns"), levelNoun("campaigns", true)], ["inbox", "inboxes", "campaign", "campaigns"]);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
