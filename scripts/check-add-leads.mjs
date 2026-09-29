// Unit checks for Add More Leads: which campaigns are originals, which is the
// newest named for a segment, and the run a source and segments make.
// Imports the REAL module.
//
//   node scripts/check-add-leads.mjs

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

const { isOriginal, familiesFor, planAddLeads, countSegments, monthOf, monthRecency } = await importTs("@/lib/campaign-types/add-leads");
const Y = "🟡", B = "🔵";
const oid = (unixSeconds, n) => unixSeconds.toString(16).padStart(8, "0") + n.toString(16).padStart(16, "0");
const t = (y, m) => Math.floor(Date.UTC(y, m - 1, 1) / 1000);

console.log("--- originals");
{
  const all = [
    { id: "1", name: `${Y} Apps (August)`, status: "ACTIVE" },
    { id: "2", name: `${B} Apps (August)`, status: "ACTIVE" },
    { id: "3", name: `${Y} Apps - Opt Out (August)`, status: "ACTIVE" },
    { id: "4", name: `Broad V2 - Signature (August)`, status: "ACTIVE" },
    { id: "5", name: `${Y} Local Business (August)`, status: "ARCHIVED" },
    { id: "6", name: `${Y} Sub`, status: "ACTIVE", campaignType: "subseq" },
    { id: "7", name: `eCommerce (August)`, status: "PAUSED" },
  ];
  eq("originals only: no 🔵, Opt Out, Signature, archived or sub-sequence", all.filter(isOriginal).map((c) => c.id), ["1", "7"]);
}

console.log("--- the newest named for a segment: by the month in the name");
{
  const sept = new Date(Date.UTC(2026, 8, 15));
  const camps = [
    { id: oid(t(2026, 9), 1), name: `${Y} Apps (July)` },
    { id: oid(t(2026, 1), 2), name: `${Y} Apps (August)` },
    { id: oid(t(2026, 6), 3), name: `${Y} Apps V2 (June)` },
    { id: oid(t(2026, 8), 4), name: `${Y} Local Business (August)` },
  ];
  eq("the month in the name decides, not when it was made", familiesFor("apps", camps, sept).map((c) => c.name), [`${Y} Apps (August)`, `${Y} Apps (July)`, `${Y} Apps V2 (June)`]);
  eq("whole words, any case", [familiesFor("APPS", camps, sept).length, familiesFor("app", camps, sept).length, familiesFor("local business", camps, sept)[0].name], [3, 0, `${Y} Local Business (August)`]);
  const jan = new Date(Date.UTC(2027, 0, 10));
  const turn = [{ id: "d", name: `${Y} Apps (December)` }, { id: "j", name: `${Y} Apps (January)` }, { id: "n", name: `${Y} Apps (November)` }];
  eq("across the new year: January is newer than December", familiesFor("apps", turn, jan).map((c) => c.id), ["j", "d", "n"]);
  const same = [{ id: "a", name: `${Y} Apps (August)`, createdAt: 1000 }, { id: "b", name: `${Y} Apps V2 (August)`, createdAt: 2000 }];
  eq("the same month: the one made later", familiesFor("apps", same, sept)[0].id, "b");
  eq("a name with no month counts as oldest", familiesFor("apps", [{ id: "x", name: `${Y} Apps` }, { id: "y", name: `${Y} Apps (March)` }], sept)[0].id, "y");
  eq("months read", [monthOf("🟡 Apps (August)"), monthOf("🟡 Apps - Opt Out (september)"), monthOf("Apps"), monthRecency(9, sept), monthRecency(10, sept)], [8, 9, 0, 12, 1]);
}

console.log("--- the run");
{
  const src = { id: "e", name: `${Y} eCommerce (August)` };
  const originals = [src, { id: "a", name: `${Y} Apps (August)` }, { id: "l", name: `${Y} Local Business (August)` }];
  const p = planAddLeads(src, ["ecommerce", "apps", "local business"], originals);
  eq("each segment finds its family; the source's own stays", p.rows.map((r) => [r.segment, r.familyId, r.isSource]), [["ecommerce", "e", true], ["apps", "a", false], ["local business", "l", false]]);
  eq("the rules sent", p.rules.map((r) => [r.segment, r.campaignId]), [["ecommerce", "e"], ["apps", "a"], ["local business", "l"]]);
  eq("the other families take only arrivals", p.arrivalFamilies.map((c) => c.id), ["a", "l"]);
  eq("nothing stops it", [p.problems, p.warnings], [[], []]);
  const odd = planAddLeads(src, ["apps", "luxury", "Apps", " "], originals);
  eq("a segment no campaign is named for stays in the source, with a warning", [odd.rows.map((r) => [r.segment, r.familyId]), odd.warnings.length, odd.problems], [[["apps", "a"], ["luxury", null]], 1, []]);
  const hand = planAddLeads(src, ["apps"], originals, { apps: "l" });
  eq("a family picked by hand wins", [hand.rows[0].familyId, hand.rows[0].auto], ["l", false]);
  eq("no source: nothing to run", planAddLeads(null, ["apps"], originals).problems, ["Pick the campaign the new leads are in."]);
}

console.log("--- what the leads carry");
{
  eq("counted case-insensitively, most first, no segment last, the most common spelling kept (first seen on a tie)",
    countSegments(["Apps", "apps", "", "APPS", " eCommerce ", "ecommerce", "", "local  business"]),
    [{ segment: "Apps", count: 3 }, { segment: "eCommerce", count: 2 }, { segment: "local business", count: 1 }, { segment: "", count: 2 }]);
  const src = { id: "e", name: "🟡 eCommerce (August)" };
  const originals = [src, { id: "a", name: "🟡 Apps (August)" }];
  const p = planAddLeads(src, ["ecommerce", "apps", "saas"], originals, {}, [{ segment: "ecommerce", count: 5 }, { segment: "APPS", count: 2 }, { segment: "Wholesale", count: 4 }, { segment: "", count: 1 }]);
  eq("segments in the leads but not the industry are added, with counts", p.rows.map((r) => [r.segment, r.count, r.fromIndustry, r.familyId]),
    [["ecommerce", 5, true, "e"], ["apps", 2, true, "a"], ["saas", 0, true, null], ["Wholesale", 4, false, null]]);
  eq("a listed segment no lead carries sends no rule and no warning", [p.rules.map((r) => r.segment), p.warnings.length], [["ecommerce", "apps"], 1]);
  eq("…the one it couldn't place is named, with its count", /"Wholesale" \(4 leads\)/.test(p.warnings[0]), true);
  const hand = planAddLeads(src, [], originals, { wholesale: "a" }, [{ segment: "Wholesale", count: 4 }]);
  eq("…and goes where it is sent by hand", [hand.rules, hand.warnings], [[{ segment: "Wholesale", campaignId: "a", campaignName: "🟡 Apps (August)" }], []]);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
