// Unit checks for Update Inbox Tags: which inbox falls in which scope, rule
// validation, the per-workspace plan, chunking, the after-the-fact check and
// the tag catalogue. Imports the REAL module.
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
const { bucketOf, inScope, validateRule, prepareRules, countProviders, planRule, chunk, verifyTags, buildCatalog, describeRules, scopeLabel } = m;

// --- which bucket an inbox is in ------------------------------------------------
eq("Google Workspace is google", bucketOf("GOOGLE_WORKSPACE"), "google");
eq("Microsoft 365 is microsoft", bucketOf("MICROSOFT365"), "microsoft");
eq("a plain account is other", bucketOf("REGULAR_ACCOUNT"), "other");
eq("no provider is other", bucketOf(undefined), "other");
eq("case doesn't matter", bucketOf("microsoft365"), "microsoft");
eq("'all' takes everything", [inScope("all", "GOOGLE_WORKSPACE"), inScope("all", undefined)], [true, true]);
eq("'google' takes only Google", [inScope("google", "GOOGLE_WORKSPACE"), inScope("google", "MICROSOFT365")], [true, false]);
eq("'other' takes what is neither", [inScope("other", "REGULAR_ACCOUNT"), inScope("other", "MICROSOFT365")], [true, false]);

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
eq("google rule: sends the untagged Google inboxes only", planRule({ scope: "google", tagName: "G", color: "#000" }, "tG", INBOXES), { matched: 2, already: 1, toAssign: ["a1"] });
eq("all rule: sends everything without the tag", planRule({ scope: "all", tagName: "G", color: "#000" }, "tG", INBOXES), { matched: 5, already: 2, toAssign: ["a1", "a3", "a4"] });
eq("microsoft rule: an old tag doesn't count as having it", planRule({ scope: "microsoft", tagName: "M", color: "#000" }, "tM", INBOXES), { matched: 2, already: 0, toAssign: ["a3", "a4"] });
eq("an empty workspace plans nothing", planRule({ scope: "all", tagName: "G", color: "#000" }, "tG", []), { matched: 0, already: 0, toAssign: [] });

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
eq("the job label reads as rules", describeRules(r.rules.slice(0, 2)), "All inboxes → Client A, Google inboxes → Google");
eq("scope labels", [scopeLabel("all"), scopeLabel("google"), scopeLabel("microsoft"), scopeLabel("other")], ["All inboxes", "Google inboxes", "Microsoft inboxes", "Other inboxes"]);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
