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

const { normalizeIndustries, saveIndustry, removeIndustry, findIndustry, matchCampaign, industryForCampaign, MAX_INDUSTRY_SEGMENTS } = await importTs("@/lib/campaign-types/industries");

console.log("--- saving");
{
  const a = saveIndustry([], { name: "  eCommerce ", segments: ["everyday", " replenish ", "", "considered"], noSegment: "Everyday" }, 1);
  eq("a new industry, tidied, with its segments in order", a.saved, { name: "eCommerce", segments: ["everyday", "replenish", "considered"], noSegment: "everyday", updatedAt: 1 });
  const b = saveIndustry(a.list, { name: "ECOMMERCE", segments: ["daily", "replenish"] }, 2);
  eq("the same name in other capitals updates it, keeping its spelling", [b.list.length, b.saved.name, b.saved.segments, b.saved.noSegment], [1, "eCommerce", ["daily", "replenish"], undefined]);
  const c = saveIndustry(b.list, { name: "SaaS", segments: ["smb", "mid"] }, 3);
  eq("the latest saved comes first", c.list.map((i) => i.name), ["SaaS", "eCommerce"]);
  eq("no name: refused", saveIndustry([], { name: " ", segments: ["x"] }, 1).problem, "Type the industry's name.");
  eq("added before any segment is typed: saved with none", saveIndustry([], { name: "SaaS", segments: ["", " "] }, 1).saved, { name: "SaaS", segments: [], updatedAt: 1 });
  eq("four segments are all kept, without repeats", saveIndustry([], { name: "X", segments: ["a", "A", "b", "c", "d"] }, 1).saved.segments, ["a", "b", "c", "d"]);
  const many = Array.from({ length: 12 }, (_, i) => `s${i + 1}`);
  eq(`at most ${MAX_INDUSTRY_SEGMENTS} segments`, saveIndustry([], { name: "X", segments: many }, 1).saved.segments, many.slice(0, MAX_INDUSTRY_SEGMENTS));
  eq("the no-segment choice must be one of its segments", saveIndustry([], { name: "X", segments: ["a"], noSegment: "z" }, 1).saved.noSegment, undefined);
  eq("found whatever the capitals", findIndustry(c.list, " saas ")?.name, "SaaS");
  eq("forgotten", removeIndustry(c.list, "saas").map((i) => i.name), ["eCommerce"]);
}

console.log("--- what an industry learns");
{
  const one = saveIndustry([], { name: "D2C", segments: ["ecommerce", "app"], families: { App: " Apps " } }, 1);
  eq("a hand pick is kept by segment, tidied", one.saved.families, { app: "Apps" });
  const two = saveIndustry(one.list, { name: "d2c", segments: ["ecommerce", "app", "local"] }, 2);
  eq("saving the segments again keeps what was learned", two.saved.families, { app: "Apps" });
  const three = saveIndustry(two.list, { name: "D2C", segments: ["app"], families: { app: "Apps V2", local: "Local Business" } }, 3);
  eq("a new pick replaces the old one and adds to the rest", three.saved.families, { app: "Apps V2", local: "Local Business" });
  eq("read back from the file", normalizeIndustries([{ name: "X", segments: [], families: { a: "A", b: "", c: 5 } }])[0].families, { a: "A" });
}

console.log("--- reading the file");
{
  eq("garbage: an empty list", normalizeIndustries("x"), []);
  eq("bad rows dropped, duplicates kept once, newest first", normalizeIndustries([
    { name: "A", segments: ["x"], updatedAt: 1 },
    { name: "a", segments: ["y"], updatedAt: 5 },
    { name: "", segments: ["x"] },
    { name: "B", segments: [], updatedAt: 2 },
    { name: "C", segments: ["q"], updatedAt: 9 },
  ]).map((i) => [i.name, i.segments]), [["C", ["q"]], ["B", []], ["A", ["x"]]]);
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

console.log("--- the industry a campaign is named for");
{
  const ind = (name, segments = []) => ({ name, segments, updatedAt: 1 });
  const list = [ind("Medical Practices & Clinics", ["cash pay", "insurance"]), ind("Health & Wellness"), ind("Health & Wellness - Clinics"), ind("eCommerce"), ind("Financial")];
  const of = (n) => industryForCampaign(n, list)?.name ?? null;
  eq("the name starts with the industry, then \" - \"", of("🟡 Medical Practices & Clinics - Cash Pay (August)"), "Medical Practices & Clinics");
  eq("…🔵 or no circle, any case", [of("🔵 medical practices & clinics - Insurance (September)"), of("Financial - Platform (August)")], ["Medical Practices & Clinics", "Financial"]);
  eq("…or is exactly it", of("🟡 eCommerce (August)"), "eCommerce");
  eq("the longest matching industry wins", of("🟡 Health & Wellness - Clinics - Cash (August)"), "Health & Wellness - Clinics");
  eq("a word that merely starts the same isn't a match", of("🟡 Financials Group - Lending (August)"), null);
  eq("no saved industry fits: none", of("🟡 Manufacturing - Service (September)"), null);
  eq("nothing saved: none", industryForCampaign("🟡 eCommerce (August)", []), null);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
