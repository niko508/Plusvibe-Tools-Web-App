// Unit checks for TLD Performance Tracking: domains, combos, the ratings,
// what goes to the sheet, and when the monthly report runs. Imports the REAL
// modules.
//
//   node scripts/check-tld-performance.mjs

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

const R = await importTs("@/lib/tld-performance/report");
const { tldOfDomain, domainOfEmail, workspaceRates, domainRows, rate, combos, buildReport, buyThese, combosCsv, sheetGrid, DEFAULT_RULES } = R;

console.log("--- basics");
eq("endings", [tldOfDomain("Acme.PRO"), tldOfDomain("mail.acme.co"), tldOfDomain("nodot")], [".pro", ".co", "(no ending)"]);
eq("domain of an address", [domainOfEmail("A@Acme.Pro"), domainOfEmail("nope")], ["acme.pro", ""]);

// Two clients: A replies at 1% on Microsoft, B at 0.25%.
const inbox = (ws, domain, provider, sent, replies, extra = {}) => ({
  workspaceId: ws, workspaceName: ws === "a" ? "Client A" : "Client B", domain, provider, sent, replies, oooReplies: 0, bounces: 0, ...extra,
});
const figs = [
  inbox("a", "one.pro", "microsoft", 1000, 15),
  inbox("a", "one.pro", "microsoft", 1000, 15),
  inbox("a", "two.live", "microsoft", 2000, 10),
  inbox("a", "g.pro", "google", 500, 5),
  inbox("b", "three.pro", "microsoft", 2000, 5),
  inbox("b", "four.live", "microsoft", 2000, 5),
  inbox("b", "idle.live", "microsoft", 0, 0),
];
const rates = workspaceRates(figs);
eq("each client's rate per provider, over sends", [rates.get("a|microsoft"), rates.get("b|microsoft"), rates.get("a|google")], [0.01, 0.0025, 0.01]);

const hosts = { "one.pro": "Dynadot", "two.live": "Namesilo", "three.pro": "Dynadot", "four.live": "Namesilo", "g.pro": "Dynadot" };
const blocked = [{ domain: "four.live", blockedAt: 5 }, { domain: "gone.pro", blockedAt: 6, provider: "microsoft", platform: "Dynadot" }];
const rows = domainRows(figs, blocked, (d) => hosts[d]);
eq("one row per sending domain, plus blocked ones already gone; an idle domain is left out",
  rows.map((r) => r.domain).sort(), ["four.live", "g.pro", "gone.pro", "one.pro", "three.pro", "two.live"]);
const one = rows.find((r) => r.domain === "one.pro");
eq("a domain sums its inboxes and prices its sends at its client's rate", [one.inboxes, one.sent, one.replies, one.expected], [2, 2000, 30, 20]);
eq("…and keeps its registrar from the sheet", one.platform, "Dynadot");
eq("a gone domain takes the block record's registrar", rows.find((r) => r.domain === "gone.pro").platform, "Dynadot");

const tagged = domainRows([
  inbox("a", "t.click", "google", 100, 1, { platformTag: "namesilo" }),
  inbox("a", "t.click", "google", 100, 1, { platformTag: "namesilo" }),
  inbox("a", "t.click", "google", 100, 1, { platformTag: "dynadot" }),
  inbox("a", "s.click", "google", 100, 1, { platformTag: "dynadot" }),
  inbox("a", "n.click", "google", 100, 1),
], [], (d) => (d === "s.click" ? "Spaceship" : undefined));
eq("no Domain Host: the platform tag most of its inboxes carry, with a capital; the sheet wins when it has one",
  tagged.map((r) => [r.domain, r.platform]).sort(), [["n.click", "Unknown platform"], ["s.click", "Spaceship"], ["t.click", "Namesilo"]]);

console.log("--- combos and ratings");
const loose = { ...DEFAULT_RULES, minDomains: 1, minClients: 1 };
const ms = combos(rows, "microsoft", loose);
const proDyn = ms.find((c) => c.tld === ".pro" && c.platform === "Dynadot");
// one.pro 30 of expected 20, three.pro 5 of expected 5: 35 / 25 = 1.4.
eq(".pro Dynadot on Microsoft: 2 domains from 2 clients, 1.4x its clients", [proDyn.domains, proDyn.clients, proDyn.sent, proDyn.replyRate, proDyn.vsClients], [2, 2, 4000, 0.88, 1.4]);
eq("…but one domain bought and lost counts against it", [proDyn.blocked, proDyn.domainsUsed, proDyn.blockRate], [1, 3, 0.3333]);
eq("…so it is Avoid, not Buy", proDyn.rating, "avoid");
const liveNs = ms.find((c) => c.platform === "Namesilo");
eq(".live Namesilo: half a block rate too", [liveNs.blocked, liveNs.domainsUsed, liveNs.rating], [1, 2, "avoid"]);
eq("the Google view only has the Google domain", combos(rows, "google", loose).map((c) => [c.tld, c.platform, c.domains]), [[".pro", "Dynadot", 1]]);

const base = { domains: 20, clients: 4, vsClients: 1.1, blocked: 0, blockRate: 0 };
const r = (o) => rate({ ...base, ...o }, DEFAULT_RULES).rating;
eq("the ratings", [r({}), r({ vsClients: 0.95 }), r({ vsClients: 1.2, blocked: 1, blockRate: 0.01 }), r({ vsClients: 0.85 }), r({ vsClients: 0.79 }), r({ blocked: 1, blockRate: 0.05 }), r({ domains: 14 }), r({ clients: 2 })],
  ["best", "good", "good", "caution", "avoid", "avoid", "little-data", "little-data"]);
eq("…with the reason in words", rate(base, DEFAULT_RULES).why, "Replies 10% above what its clients predict, and none blocked.");

console.log("--- the report");
const many = [];
for (let i = 0; i < 16; i++) many.push(inbox(i % 2 ? "a" : "b", `d${i}.pro`, "microsoft", 1000, i % 2 ? 12 : 3));
for (let i = 0; i < 16; i++) many.push(inbox(i % 2 ? "a" : "b", `s${i}.biz`, "microsoft", 1000, i % 2 ? 12 : 3));
many.push(inbox("a", "x.biz", "microsoft", 1000, 10), inbox("b", "y.biz", "microsoft", 1000, 2), inbox("c", "z.biz", "microsoft", 1000, 4), inbox("c", "w.pro", "microsoft", 1000, 4));
const rep = buildReport(many, [], (d) => (d.endsWith(".pro") ? "Dynadot" : "Spaceship"), { ...DEFAULT_RULES, minClients: 2 });
// .pro: 124 replies against 122.6 its clients predict; .biz: 136 against 137.4.
eq("a combo just above its clients is Buy, just below is OK",
  rep.combos.all.map((c) => [c.platform, c.rating, c.vsClients, c.hidden]), [["Dynadot", "best", 1.01, false], ["Spaceship", "good", 0.99, true]]);
eq("a hidden registrar is never in Buy these, whatever its numbers",
  buyThese([{ platform: "Dynadot", rating: "best", hidden: false }, { platform: "Spaceship", rating: "best", hidden: true }]).map((c) => c.platform), ["Dynadot"]);
eq("…nor an unknown one", buyThese([{ platform: "Unknown platform", rating: "best", hidden: false }]), []);
eq("totals per view", [rep.totals.all.domains, rep.totals.all.sent, rep.totals.google.domains], [36, 36000, 0]);
eq("the CSV has a row per combo", combosCsv(rep.combos.all).split("\n").length, 3);
const grid = sheetGrid({ month: "2026-10", combos: rep.combos.all, totals: rep.totals.all, view: "all", updated: "Sun 1 Nov, 06:00 Helsinki" });
eq("the sheet: a title, Buy these, then every combo", [grid[0][0], grid[3][0], grid[4].slice(0, 3), grid[6][0]],
  ["TLD Performance · October 2026", "Buy these", [".pro", "Dynadot", "0.73%"], "Every combo"]);
eq("…with the hidden registrar marked", grid[8][2], "OK (not buying)");

console.log("--- the monthly run");
const S = await importTs("@/lib/tld-performance/schedule");
const NOV11 = Date.UTC(2026, 10, 11, 12);
eq("months", [S.monthOf(NOV11), S.previousMonth("2026-01"), S.lastFullMonth(NOV11)], ["2026-11", "2025-12", "2026-10"]);
eq("a month's days", [S.monthRange("2026-02"), S.monthRange("2028-02"), S.monthRange("2026-10")],
  [{ start: "2026-02-01", end: "2026-02-28" }, { start: "2028-02-01", end: "2028-02-29" }, { start: "2026-10-01", end: "2026-10-31" }]);
eq("what counts as a month", [S.isMonth("2026-10"), S.isMonth("2026-13"), S.isMonth("26-10"), S.isMonth(5)], [true, false, false, false]);
// 1 Nov 06:00 Helsinki is 04:00 UTC (EET, +2).
const DUE = Date.UTC(2026, 10, 1, 4);
eq("it runs on the 1st at 06:00 Helsinki", S.dueThisMonth(NOV11), DUE);
eq("due once past it, until October is made", [S.isDue(NOV11, "2026-09"), S.isDue(NOV11, "2026-10"), S.isDue(DUE - 60_000, "2026-09")], [true, false, false]);
eq("next run after October is 1 Dec 06:00", S.nextRunAt(NOV11, "2026-10"), Date.UTC(2026, 11, 1, 4));
eq("…and in December it is 1 Jan", S.nextRunAt(Date.UTC(2026, 11, 5), "2026-11"), Date.UTC(2027, 0, 1, 4));
eq("the defaults", S.normalizeTldSettings(null),
  { enabled: true, sheetUrl: "", sheetTab: "TLD Performance", rules: { minDomains: 15, minClients: 3, hiddenPlatforms: ["Spaceship", "Porkbun"] }, updatedAt: 0 });
eq("a bad patch says what is wrong", S.validateTldPatch({ enabled: "yes", rules: { minDomains: 0 } }),
  ["Monthly run: on or off.", "Minimum domains: a whole number from 1 to 1,000."]);

console.log(failures === 0 ? "\nall TLD performance checks OK" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
