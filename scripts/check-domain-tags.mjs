// Unit checks for Auto-tag by Domain: TLDs from domains, matching tag sets,
// reading the Domains sheet grid, and the per-workspace plan. Imports the
// REAL module.
//
//   node scripts/check-domain-tags.mjs

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

const m = await importTs("@/lib/tags/domain-tags");
const { DEFAULT_TLD_TAGS, DEFAULT_PLATFORM_TAGS, tldOf, tldKey, findTldTag, findPlatformTag, parseDomainHosts, planInboxes, topCounts } = m;

// --- TLDs --------------------------------------------------------------------------
eq("plain domain", tldOf("acme-mail.com"), ".com");
eq("multi-label domain takes the last label", tldOf("mail.acme.co"), ".co");
eq("a full email is reduced to its domain first", tldOf("niko@acme.digital"), ".digital");
eq("upper case is lowered", tldOf("ACME.PRO"), ".pro");
eq("trailing dot is ignored", tldOf("acme.live."), ".live");
eq("no dot → null", tldOf("localhost"), null);
eq("empty → null", tldOf(""), null);
eq("tag names compare without the dot", [tldKey(".com"), tldKey("com"), tldKey(" .COM ")], ["com", "com", "com"]);
eq("finds the .com tag", findTldTag("acme.com", DEFAULT_TLD_TAGS)?.name, ".com");
eq("finds a tag named without the dot", findTldTag("acme.com", [{ name: "com" }])?.name, "com");
eq("no tag for .io", findTldTag("acme.io", DEFAULT_TLD_TAGS), undefined);

// --- platforms ------------------------------------------------------------------------
eq("exact host", findPlatformTag("porkbun", DEFAULT_PLATFORM_TAGS)?.name, "porkbun");
eq("host in another case", findPlatformTag("Dynadot", DEFAULT_PLATFORM_TAGS)?.name, "dynadot");
eq("host with a suffix", findPlatformTag("Porkbun.com", DEFAULT_PLATFORM_TAGS)?.name, "porkbun");
eq("host with spaces around", findPlatformTag("  spaceship ", DEFAULT_PLATFORM_TAGS)?.name, "spaceship");
eq("unknown host", findPlatformTag("GoDaddy", DEFAULT_PLATFORM_TAGS), undefined);
eq("empty host", findPlatformTag("", DEFAULT_PLATFORM_TAGS), undefined);
eq("exact beats contains", findPlatformTag("silo", [{ name: "namesilo" }, { name: "silo" }])?.name, "silo");

// --- the sheet grid --------------------------------------------------------------------
const GRID = [
  ["Client", "Domain", "Domain Host", "Status"],
  ["Acme", "acme.com", "Porkbun", "Active"],
  ["Acme", "https://www.acme-mail.co/", "dynadot", "Active"],
  ["Acme", "acme.live", "", "Active"],
  ["Acme", "acme.pro", "-", "Active"],
  ["", "", "", ""],
  ["Beta", "BETA.ORG", "GoDaddy", "Active"],
];
const sheet = parseDomainHosts(GRID);
eq("domains are normalised, hosts kept as written", [...sheet.hosts.entries()], [["acme.com", "Porkbun"], ["acme-mail.co", "dynadot"], ["beta.org", "GoDaddy"]]);
eq("rows with a domain are counted, blank/dash hosts not mapped", sheet.rows, 5);
let threw = null;
try { parseDomainHosts([["Client", "Domain"], ["a", "b"]]); } catch (e) { threw = e.message; }
eq("a missing column is an error naming it", threw, 'Could not find the column "Domain Host" in the Domains tab.');
try { parseDomainHosts([]); } catch (e) { threw = e.message; }
eq("an empty grid is an error", threw, "The Domains tab is empty.");
eq("'Domain' matches exactly, not 'Domain Host'", [...parseDomainHosts([["Domain Host", "Domain"], ["Porkbun", "x.com"]]).hosts.entries()], [["x.com", "Porkbun"]]);

// --- the plan ------------------------------------------------------------------------------
const TLDS = [{ name: ".com", id: "tCom" }, { name: ".co", id: "tCo" }, { name: ".org", id: "tOrg" }];
const PLATFORMS = [{ name: "porkbun", id: "tPork" }, { name: "dynadot", id: "tDyna" }];
const HOSTS = sheet.hosts;
const INBOXES = [
  { id: "a1", email: "a@acme.com", tags: [] },                 // both to add
  { id: "a2", email: "b@acme.com", tags: ["tCom"] },           // has TLD, platform to add
  { id: "a3", email: "c@acme.com", tags: ["tPork", "other"] },  // has platform, TLD to add
  { id: "a4", email: "d@acme-mail.co", tags: ["tCo", "tDyna"] }, // has both
  { id: "a5", email: "e@acme.live", tags: [] },                // .live not in set, host blank
  { id: "a6", email: "f@beta.org", tags: [] },                 // .org ok, GoDaddy not in set
  { id: "a7", email: "g@unknown.com", tags: [] },              // .com ok, not in sheet
  { id: "a8", email: "broken", tags: [] },                     // no domain
  { id: "", email: "x@acme.com", tags: [] },                   // no id — skipped
];
const plan = planInboxes(INBOXES, TLDS, PLATFORMS, HOSTS);
eq("counts", plan.counts, { tldAssign: 4, tldHas: 2, tldNoTag: 1, platformAssign: 2, platformHas: 2, notInSheet: 3, hostNoTag: 1 });
eq("assignments grouped per tag", [...plan.assignments.entries()], [["tCom", ["a1", "a3", "a7"]], ["tPork", ["a1", "a2"]], ["tOrg", ["a6"]]]);
eq("per-inbox outcomes", plan.plans.map((p) => `${p.id}:${p.tld}/${p.platform}`), [
  "a1:assign/assign", "a2:has/assign", "a3:assign/has", "a4:has/has", "a5:no-tag/not-in-sheet", "a6:assign/no-tag", "a7:assign/not-in-sheet", "a8:no-domain/not-in-sheet",
]);
eq("…with the tag names and host", [plan.plans[0].tldTag, plan.plans[0].platformTag, plan.plans[0].host], [".com", "porkbun", "Porkbun"]);
eq("TLDs outside the set are listed", [...plan.unknownTlds.entries()], [[".live", 1]]);
eq("hosts outside the set are listed", [...plan.unknownHosts.entries()], [["GoDaddy", 1]]);
eq("an empty workspace plans nothing", planInboxes([], TLDS, PLATFORMS, HOSTS).assignments.size, 0);
eq("no platform tags at all → nothing on that side is assigned", planInboxes(INBOXES, TLDS, [], HOSTS).counts.platformAssign, 0);
eq("no sheet → everything is 'not in sheet', TLDs still assigned", (() => { const p = planInboxes(INBOXES, TLDS, PLATFORMS, new Map()); return [p.counts.tldAssign, p.counts.platformAssign, p.counts.notInSheet]; })(), [4, 0, 6]);
eq("topCounts reads well", topCounts(new Map([["a", 1], ["b", 5], ["c", 2]]), 2), "b ×5, c ×2, +1 more");

// --- the defaults are the sets on the account ---------------------------------------------
eq("default TLD tags", DEFAULT_TLD_TAGS.map((t) => t.name), [".co", ".com", ".digital", ".live", ".one", ".org", ".pro"]);
eq("default platform tags", DEFAULT_PLATFORM_TAGS.map((t) => t.name), ["porkbun", "dynadot", "namesilo", "spaceship"]);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
