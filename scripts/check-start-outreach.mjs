// Unit checks for Start Outreach with New Inboxes, phase 1: reading how long
// an inbox has warmed and deciding whether it is ready. Imports the REAL module.
//
//   node scripts/check-start-outreach.mjs

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

const {
  DAY_MS,
  parseMinDays,
  parseWhen,
  warmupDays,
  judge,
  countVerdicts,
  describeSkipped,
  DEFAULT_RULES,
  normalizeDomain,
  warmupFromGrid,
  resolveWarmupStart,
  groupByDomain,
  domainVerdict,
  selectionTotals,
} = await importTs("@/lib/start-outreach/readiness");

const NOW = Date.parse("2026-09-11T12:00:00Z");
const daysAgo = (n) => new Date(NOW - n * DAY_MS).toISOString();

// --- the days box -----------------------------------------------------------
eq("14 is read as 14", parseMinDays("14"), { value: 14, problem: null });
eq("zero is allowed, meaning no minimum", parseMinDays("0").problem, null);
eq("blank is asked for", parseMinDays("  ").problem, "Set how many days of warmup to require.");
eq("a fraction is refused", parseMinDays("2.5").problem, "Days must be a whole number.");
eq("text is refused", parseMinDays("soon").problem, "Days must be a whole number.");
eq("a year and a day is too far", parseMinDays("366").problem, "Days must be between 0 and 365.");

// --- reading Plusvibe's timestamp -------------------------------------------
eq("an ISO string is read", parseWhen("2026-09-01T00:00:00.000Z"), Date.parse("2026-09-01T00:00:00.000Z"));
eq("epoch seconds are scaled up", parseWhen(1_756_684_800), 1_756_684_800_000);
eq("epoch milliseconds are left alone", parseWhen(1_756_684_800_000), 1_756_684_800_000);
eq("…even as a string of digits", parseWhen("1756684800"), 1_756_684_800_000);
eq("nothing is null", parseWhen(undefined), null);
eq("an empty string is null", parseWhen(""), null);
eq("junk is null", parseWhen("last Tuesday"), null);

eq("days are counted whole, rounding down", warmupDays(daysAgo(14.9), NOW), 14);
eq("exactly 14 days is 14", warmupDays(daysAgo(14), NOW), 14);
eq("a future date reads as zero, not negative", warmupDays(daysAgo(-2), NOW), 0);
eq("unknown start is null", warmupDays(undefined, NOW), null);

// --- the verdict ------------------------------------------------------------
const rules = { minDays: 14, skipInCampaign: true };
const j = (over) => judge({ warmupStatus: "ACTIVE", warmupEnabledAt: daysAgo(20), campaignIds: [], ...over }, rules, NOW);

eq("warming 20 days, free, is ready", j({}), { verdict: "ready", days: 20 });
eq("exactly 14 days counts", j({ warmupEnabledAt: daysAgo(14) }), { verdict: "ready", days: 14 });
eq("13 days is still warming", j({ warmupEnabledAt: daysAgo(13) }).verdict, "too-new");
eq("warmup off wins over everything", j({ warmupStatus: "INACTIVE" }).verdict, "warmup-off");
eq("…however it is spelled", j({ warmupStatus: "active" }).verdict, "ready");
eq("…and missing counts as off", j({ warmupStatus: undefined }).verdict, "warmup-off");
eq("no start date is said, not guessed", j({ warmupEnabledAt: undefined }).verdict, "no-start-date");
eq("…even when warmup is on", j({ warmupEnabledAt: "garbage" }), { verdict: "no-start-date", days: null });
eq("already in a campaign is not new", j({ campaignIds: ["c1"] }).verdict, "in-campaign");
eq(
  "…unless that rule is off",
  judge({ warmupStatus: "ACTIVE", warmupEnabledAt: daysAgo(20), campaignIds: ["c1"] }, { minDays: 14, skipInCampaign: false }, NOW).verdict,
  "ready"
);
eq(
  "a minimum of zero makes any warming inbox ready",
  judge({ warmupStatus: "ACTIVE", warmupEnabledAt: daysAgo(0.5), campaignIds: [] }, { minDays: 0, skipInCampaign: true }, NOW).verdict,
  "ready"
);
eq("the defaults are 14 days and skip in-campaign", DEFAULT_RULES, { minDays: 14, skipInCampaign: true });

const counts = countVerdicts(["ready", "too-new", "too-new", "warmup-off", "ready", "ready"]);
eq("verdicts are counted", [counts.ready, counts["too-new"], counts["warmup-off"]], [3, 2, 1]);
eq("…and the rest is said in words, most common first", describeSkipped(counts), "2 still warming, 1 warmup off");
eq("all ready says nothing", describeSkipped(countVerdicts(["ready"])), "");

// --- the sheet's dates, and the fallback to Plusvibe ------------------------
eq("a domain is matched however it is written", normalizeDomain("  https://www.Acme.com/ "), "acme.com");
eq("a trailing dot is dropped", normalizeDomain("acme.com."), "acme.com");

const grid = [
  ["Domain", "Tenant Email Address", "Status", "Warmup Started", "Warmup Days", "Domain Host", "Client"],
  ["grimmont.org", "admin@x.onmicrosoft.com", "Warming Up", "2026-08-28", "14", "Dynadot", "Acme"],
  ["feneo.co", "admin@y.onmicrosoft.com", "Warming Up", "2026-08-24", "18", "Dynadot", "-"],
  ["drepurke.co", "admin@z.onmicrosoft.com", "Warming Up", "", "", "Dynadot", ""],
  ["daysonly.co", "", "Warming Up", "", "9", "", ""],
  ["blank.co", "", "", "", "", "", ""],
  ["GRIMMONT.ORG", "", "Warming Up", "2020-01-01", "", "", ""],
];
const sheet = warmupFromGrid(grid);
eq("the tab reads without complaint", sheet.problem, null);
eq(
  "a domain with a start date is read, with its host and client",
  sheet.byDomain.get("grimmont.org"),
  { started: "2026-08-28", days: "14", host: "Dynadot", client: "Acme" }
);
eq("…the first row wins over a repeat", sheet.byDomain.get("grimmont.org").started, "2026-08-28");
eq("a dash in a cell reads as nothing", sheet.byDomain.get("feneo.co").client, undefined);
eq("a domain with only a host is kept for the platform tag", sheet.byDomain.get("drepurke.co"), { host: "Dynadot" });
eq("a row with blank cells is still in the sheet, with nothing in it", sheet.byDomain.get("blank.co"), {});
eq("days alone is still kept", sheet.byDomain.get("daysonly.co"), { started: undefined, days: "9" });
eq("a tab with no Domain column says so", warmupFromGrid([["Foo", "Bar"]]).problem, 'No "Domain" column.');
eq(
  "…and one with neither warmup column too",
  warmupFromGrid([["Domain", "Status"]]).problem,
  'No "Warmup Started" or "Warmup Days" column.'
);
eq("an empty tab is said", warmupFromGrid([]).problem, "The sheet tab is empty.");

const pv = daysAgo(3);
eq(
  "the sheet's date wins over Plusvibe's",
  resolveWarmupStart({ started: "2026-08-28", days: "14" }, pv, NOW),
  { at: Date.parse("2026-08-28"), source: "sheet" }
);
eq(
  "a blank date with a day count is worked back from today",
  resolveWarmupStart({ days: "9" }, pv, NOW),
  { at: NOW - 9 * DAY_MS, source: "sheet" }
);
eq(
  "nothing in the sheet falls back to Plusvibe",
  resolveWarmupStart(undefined, pv, NOW),
  { at: Date.parse(pv), source: "plusvibe" }
);
eq(
  "…so does a row with only blanks",
  resolveWarmupStart({ started: "", days: "" }, pv, NOW).source,
  "plusvibe"
);
eq(
  "an unreadable sheet date is not trusted; Plusvibe is used",
  resolveWarmupStart({ started: "soon" }, pv, NOW).source,
  "plusvibe"
);
eq("nothing anywhere is none", resolveWarmupStart(undefined, undefined, NOW), { at: null, source: "none" });

// The sheet's date, once resolved, feeds the same verdict.
const resolved = resolveWarmupStart({ started: daysAgo(14) }, daysAgo(2), NOW);
eq(
  "an inbox Plusvibe thinks is 2 days old is ready when the sheet says 14",
  judge({ warmupStatus: "ACTIVE", warmupEnabledAt: resolved.at, campaignIds: [] }, rules, NOW),
  { verdict: "ready", days: 14 }
);

// --- by domain, and what a selection adds up to -----------------------------
const inbox = (email, verdict, days, source = "sheet", provider = "MICROSOFT365") => ({
  email,
  domain: email.slice(email.indexOf("@") + 1),
  provider,
  verdict,
  days,
  source,
});
const groups = groupByDomain([
  inbox("a@big.co", "ready", 14),
  inbox("b@big.co", "ready", 14),
  inbox("c@big.co", "warmup-off", 14),
  inbox("d@big.co", "ready", 14, "sheet", "GOOGLE_WORKSPACE"),
  inbox("a@young.co", "too-new", 5, "plusvibe"),
  inbox("a@Small.co.", "ready", 20, "plusvibe"),
]);
eq("domains are listed with the most to move first", groups.map((g) => g.domain), ["big.co", "small.co", "young.co"]);
const big = groups[0];
eq("…each counting its inboxes", [big.total, big.ready], [4, 3]);
eq("…by provider, most common first", big.providers, [["MICROSOFT365", 3], ["GOOGLE_WORKSPACE", 1]]);
eq("…with the longest warmup and where it came from", [big.days, big.source], [14, "sheet"]);
eq("…and exactly the ready addresses a move would take", big.readyEmails, ["a@big.co", "b@big.co", "d@big.co"]);
eq("a domain is matched however its inboxes spell it", groups[1].domain, "small.co");

eq("a domain with a stopped inbox is partly ready", domainVerdict(big), "partly");
eq("one where every inbox is ready is ready", domainVerdict(groups[1]), "ready");
eq("one with nothing ready carries the reason", domainVerdict(groups[2]), "too-new");

const picked = selectionTotals(groups, new Set(["big.co", "small.co"]));
eq("picking domains adds up their ready inboxes", [picked.domains, picked.inboxes], [2, 4]);
eq("…and lists them", picked.emails, ["a@big.co", "b@big.co", "d@big.co", "a@small.co"]);
eq("picking nothing is nothing", selectionTotals(groups, new Set()).inboxes, 0);
eq("picking a domain with nothing ready moves nothing", selectionTotals(groups, new Set(["young.co"])).inboxes, 0);

// ===========================================================================
// Phase 2: what the move does in the client workspace (plan.ts)
// ===========================================================================
const {
  EMPTY_OUTREACH_SETTINGS,
  parseOutreachSettings,
  signatureFieldsUsable,
  planSignatures,
  previewDomainTags,
  countsInWords,
  previewClientColumn,
  planSheetWrites,
  describeRun,
  domainsOf,
} = await importTs("@/lib/start-outreach/plan");
const { DEFAULT_TLD_TAGS, DEFAULT_PLATFORM_TAGS } = await importTs("@/lib/tags/domain-tags");

// --- settings ---------------------------------------------------------------
const all = parseOutreachSettings({
  campaignEmails: "30",
  warmupEmails: "40",
  randomize: "20",
  warmupReplyRate: "46",
  intervalMinutes: "5",
});
eq("every field goes out under its API name", all.body, {
  warmup_max_daily_limit: 40,
  daily_limit: 30,
  warmup_randomize: "yes",
  warmup_randomize_num: 20,
  warmup_reply_rate: 0.46,
  interval_limit_in_min: 5,
  bulk_is_slow_rampup: "no",
  bulk_warmup_is_slow_rampup: "no",
});
eq("…and both ramp-ups are always off", all.summary.slice(-2).map((r) => `${r.label}: ${r.value}`), [
  "Campaign email ramp-up: Off",
  "Warmup email ramp-up: Off",
]);
eq("…reading fine", all.ok, true);
const none = parseOutreachSettings(EMPTY_OUTREACH_SETTINGS);
eq("blank fields are left alone, only the switches go", none.body, { bulk_is_slow_rampup: "no", bulk_warmup_is_slow_rampup: "no" });
eq("…which is still a valid run", none.ok, true);
eq("randomize 0 is said as off", parseOutreachSettings({ ...EMPTY_OUTREACH_SETTINGS, randomize: "0" }).body.warmup_randomize, "no");
eq("a reply rate is a 0–1 fraction on the wire", parseOutreachSettings({ ...EMPTY_OUTREACH_SETTINGS, warmupReplyRate: "12.5" }).body.warmup_reply_rate, 0.125);
eq("a bad number is named", parseOutreachSettings({ ...EMPTY_OUTREACH_SETTINGS, intervalMinutes: "0" }).problems.intervalMinutes, "Email interval must be between 1 and 1440 minutes.");
eq("the ramp-up values are not asked for", Object.keys(EMPTY_OUTREACH_SETTINGS), ["campaignEmails", "warmupEmails", "randomize", "warmupReplyRate", "intervalMinutes"]);
eq("…and so is text", parseOutreachSettings({ ...EMPTY_OUTREACH_SETTINGS, warmupEmails: "lots" }).problems.warmupEmails, "Warmup emails must be a number.");
eq("a fraction where a whole number is due is refused", parseOutreachSettings({ ...EMPTY_OUTREACH_SETTINGS, intervalMinutes: "2.5" }).ok, false);

// --- signatures -------------------------------------------------------------
eq("signatures need a title and a company", signatureFieldsUsable({ titles: ["AE"], companies: [""], phones: [], addresses: [] }), false);
eq("…and are usable with both", signatureFieldsUsable({ titles: ["AE"], companies: ["Acme"], phones: [], addresses: [] }), true);
eq("nothing is not usable", signatureFieldsUsable(null), false);
const moving = [
  { id: "1", email: "a@x.co", domain: "x.co", provider: "MICROSOFT365", firstName: "Alice", lastName: "Ford" },
  { id: "2", email: "b@x.co", domain: "x.co", provider: "MICROSOFT365", firstName: "alice", lastName: "ford" },
  { id: "3", email: "c@y.org", domain: "y.org", provider: "GOOGLE_WORKSPACE", firstName: "Bob" },
  { id: "4", email: "d@y.org", domain: "y.org", provider: "GOOGLE_WORKSPACE", firstName: "" },
];
const sp = planSignatures(moving);
eq("inboxes are grouped by the person named on them", sp.people.map((p) => [p.key, p.ids]), [["alice ford", ["1", "2"]], ["bob", ["3"]]]);
eq("…counting who can be signed and who cannot", [sp.withName, sp.noName], [3, 1]);

// --- tags -------------------------------------------------------------------
const tp = previewDomainTags(moving, { "x.co": "Porkbun.com", "y.org": "GoDaddy" }, DEFAULT_TLD_TAGS, DEFAULT_PLATFORM_TAGS);
eq("each domain gets its TLD tag", tp.rows.map((r) => [r.domain, r.tldTag]), [["x.co", ".co"], ["y.org", ".org"]]);
eq("…and the platform tag its host matches", tp.rows.map((r) => r.platformTag), ["porkbun", undefined]);
eq("…counting inboxes per tag", [countsInWords(tp.tldCounts), countsInWords(tp.platformCounts)], [".co ×2, .org ×2", "porkbun ×2"]);
eq("a host with no tag is counted", tp.hostNoTag, 1);
eq("a domain the sheet has no host for is counted", previewDomainTags(moving, {}, DEFAULT_TLD_TAGS, DEFAULT_PLATFORM_TAGS).notInSheet, 2);
eq("an unknown TLD is counted, not guessed", previewDomainTags([{ ...moving[0], domain: "x.xyz" }], {}, DEFAULT_TLD_TAGS, []).tldNoTag, 1);

// --- the sheet's Client column ---------------------------------------------
const cp = previewClientColumn(["x.co", "y.org", "z.net"], { "x.co": { client: "Acme" }, "y.org": { client: "" } }, "Acme");
eq("domains in the sheet are told from the rest", [cp.inSheet.map((r) => r.domain), cp.notInSheet], [["x.co", "y.org"], ["z.net"]]);
eq("…and rows that already say the client are counted", cp.alreadySet, 1);

eq("…and rows still carrying warmup dates", previewClientColumn(["x.co", "y.org"], { "x.co": { started: "2026-08-19", days: "23" }, "y.org": {} }, "Acme").withWarmup, 1);

const sheetGrid = [
  ["Domain", "Status", "Warmup Started", "Warmup Days", "Client"],
  ["x.co", "Active", "", "", "acme"],
  ["Y.ORG", "Warming Up", "2026-08-19", "23", "Old"],
  ["w.co", "Warming Up", "", "", ""],
];
const sw = planSheetWrites(sheetGrid, ["x.co", "y.org", "z.net"], "Acme");
eq("a moved domain gets its client, an Active status and its warmup cells cleared", sw.writes, [
  { domain: "y.org", row: 3, column: 4, value: "Acme" },
  { domain: "y.org", row: 3, column: 1, value: "Active" },
  { domain: "y.org", row: 3, column: 2, value: "" },
  { domain: "y.org", row: 3, column: 3, value: "" },
]);
eq("…a row that already reads that way is not written", [sw.rows, sw.alreadySet, sw.notInSheet], [["y.org"], ["x.co"], ["z.net"]]);
eq("…and only the cells that differ are", planSheetWrites(sheetGrid, ["w.co"], "Acme").writes.map((w) => [w.column, w.value]), [[4, "Acme"], [1, "Active"]]);
eq("a tab without the Client column says so", planSheetWrites([["Domain", "Status"]], ["x.co"], "Acme").problem, 'No "Client" column in the Domains tab.');
const noStatus = planSheetWrites([["Domain", "Client"], ["x.co", ""]], ["x.co"], "Acme");
eq("a tab without the status or warmup columns still gets its client, and says what is missing", [noStatus.writes.length, noStatus.missingColumns], [1, ["Status", "Warmup Started", "Warmup Days"]]);
eq("an empty tab says so", planSheetWrites([], ["x.co"], "Acme").problem, "The Domains tab is empty.");

eq("domains are counted once, however spelled", domainsOf([{ domain: "X.co" }, { domain: "x.co." }, { domain: "y.org" }]), ["x.co", "y.org"]);
eq("a run reads as a sentence", describeRun({ inboxes: 3, domains: 2, source: "Warming", destination: "Client A" }), "3 inboxes on 2 domains · Warming → Client A");

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
