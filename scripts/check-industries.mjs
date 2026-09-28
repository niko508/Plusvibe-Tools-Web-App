// Unit checks for Create All Campaign Types' saved industries: reading the
// list, saving and forgetting one, and matching a segment to its original.
// Imports the REAL module.
//
//   node scripts/check-industries.mjs

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

const { normalizeIndustries, saveIndustry, removeIndustry, findIndustry, matchCampaign, MAX_INDUSTRY_SEGMENTS } = await importTs("@/lib/campaign-types/industries");

console.log("--- saving");
{
  const a = saveIndustry([], { name: "  eCommerce ", segments: ["everyday", " replenish ", "", "considered"], noSegment: "Everyday" }, 1);
  eq("a new industry, tidied, with its segments in order", a.saved, { name: "eCommerce", segments: ["everyday", "replenish", "considered"], noSegment: "everyday", updatedAt: 1 });
  const b = saveIndustry(a.list, { name: "ECOMMERCE", segments: ["daily", "replenish"] }, 2);
  eq("the same name in other capitals updates it, keeping its spelling", [b.list.length, b.saved.name, b.saved.segments, b.saved.noSegment], [1, "eCommerce", ["daily", "replenish"], undefined]);
  const c = saveIndustry(b.list, { name: "SaaS", segments: ["smb", "mid"] }, 3);
  eq("the latest saved comes first", c.list.map((i) => i.name), ["SaaS", "eCommerce"]);
  eq("no name: refused", saveIndustry([], { name: " ", segments: ["x"] }, 1).problem, "Type the industry's name.");
  eq("no segments: refused", saveIndustry([], { name: "X", segments: ["", " "] }, 1).problem, "Fill in at least one segment to save for it.");
  eq(`at most ${MAX_INDUSTRY_SEGMENTS} segments, no repeats`, saveIndustry([], { name: "X", segments: ["a", "A", "b", "c", "d"] }, 1).saved.segments, ["a", "b", "c"]);
  eq("the no-segment choice must be one of its segments", saveIndustry([], { name: "X", segments: ["a"], noSegment: "z" }, 1).saved.noSegment, undefined);
  eq("found whatever the capitals", findIndustry(c.list, " saas ")?.name, "SaaS");
  eq("forgotten", removeIndustry(c.list, "saas").map((i) => i.name), ["eCommerce"]);
}

console.log("--- reading the file");
{
  eq("garbage: an empty list", normalizeIndustries("x"), []);
  eq("bad rows dropped, duplicates kept once, newest first", normalizeIndustries([
    { name: "A", segments: ["x"], updatedAt: 1 },
    { name: "a", segments: ["y"], updatedAt: 5 },
    { name: "", segments: ["x"] },
    { name: "B", segments: [] },
    { name: "C", segments: ["q"], updatedAt: 9 },
  ]).map((i) => [i.name, i.segments]), [["C", ["q"]], ["A", ["x"]]]);
}

console.log("--- matching a segment to its original");
{
  const camps = [
    { id: "1", name: "🟡 eCommerce - Free Trial - Considered (August)" },
    { id: "2", name: "🟡 eCommerce - Free Trial - Replenish (August)" },
    { id: "3", name: "🟡 eCommerce - Free Trial - Everyday (August)" },
  ];
  eq("each segment finds its campaign, whatever the case", ["everyday", "Replenish", "considered"].map((s) => matchCampaign(s, camps)), ["3", "2", "1"]);
  eq("whole words only", matchCampaign("day", camps), null);
  eq("in more than one: no answer", matchCampaign("free trial", camps), null);
  eq("in none: no answer", matchCampaign("luxury", camps), null);
  eq("punctuation is ignored", matchCampaign("free-trial everyday", camps), "3");
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
