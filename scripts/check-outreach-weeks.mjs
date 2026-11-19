// Unit checks for the Start Outreach week 1 / week 2 rework: how a domain is
// sorted into Google / Azure 25 / Azure 50, the saved settings, and the clock
// that decides when a batch moves onto week 2. Imports the REAL modules.
//
//   node scripts/check-outreach-weeks.mjs

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

const C = await importTs("@/lib/start-outreach/categories");
const W = await importTs("@/lib/start-outreach/week-settings");
const S = await importTs("@/lib/start-outreach/schedule");

const G = "GOOGLE_WORKSPACE", M = "MICROSOFT365", R = "REGULAR_ACCOUNT";

// --- which kind of infrastructure a domain is --------------------------------
console.log("--- the categories");
eq("three kinds, in the order the form shows them", C.CATEGORIES, ["google", "azure25", "azure50"]);
eq("…named as asked", C.CATEGORIES.map((c) => C.CATEGORY_LABELS[c]), ["Google Inboxes", "Azure 25", "Azure 50"]);
eq("Google is Google whatever the count", [C.categoryOf([[G, 3]], 3), C.categoryOf([[G, 40]], 40)], ["google", "google"]);
// The split is by mailboxes ON THE DOMAIN: 25 or fewer is a 25, more is a 50.
eq("the Azure split falls at 25", [24, 25, 26, 50].map((n) => C.categoryOf([[M, n]], n)),
  ["azure25", "azure25", "azure50", "azure50"]);
// A domain with more than a 50-seat tenant is still a 50 — there is no third
// Azure bracket, and calling it a 25 would throttle it.
eq("more than fifty is still an Azure 50", C.categoryOf([[M, 80]], 80), "azure50");
eq("one inbox is an Azure 25", C.categoryOf([[M, 1]], 1), "azure25");
// The count is the DOMAIN's, not the batch's: a 50-seat domain with 3 warmed
// must not be handed a 25's numbers.
eq("a barely-warmed 50 is still a 50", C.categoryOf([[M, 50]], 50), "azure50");
eq("a stray mailbox of the other kind does not flip a domain",
  [C.categoryOf([[G, 20], [M, 1]], 21), C.categoryOf([[M, 30], [G, 1]], 31)], ["google", "azure50"]);
// A genuine tie is a domain to look at, not to guess at.
eq("an even split has no category", C.categoryOf([[G, 5], [M, 5]], 10), null);
eq("plain SMTP has no category", C.categoryOf([[R, 4]], 4), null);
eq("nothing at all has no category", C.categoryOf([], 0), null);

eq("domains are categorised in one pass",
  [...C.categorizeDomains([
    { domain: "g.com", total: 3, providers: [[G, 3]] },
    { domain: "small.io", total: 20, providers: [[M, 20]] },
    { domain: "big.io", total: 44, providers: [[M, 44]] },
    { domain: "smtp.io", total: 2, providers: [[R, 2]] },
  ]).entries()],
  [["g.com", "google"], ["small.io", "azure25"], ["big.io", "azure50"]]);

// --- splitting a batch --------------------------------------------------------
console.log("--- splitting a batch");
const batch = [
  { email: "a@big.io", domain: "big.io", category: "azure50" },
  { email: "b@g.com", domain: "g.com", category: "google" },
  { email: "c@big.io", domain: "big.io", category: "azure50" },
  { email: "d@smtp.io", domain: "smtp.io", category: null },
  { email: "e@small.io", domain: "small.io", category: "azure25" },
];
const split = C.splitByCategory(batch);
eq("only the categories present, in CATEGORIES order",
  split.groups.map((g) => [g.category, g.inboxes.length]), [["google", 1], ["azure25", 1], ["azure50", 2]]);
// Never silently lumped into a category: they are moved, but get no settings.
eq("an uncategorised inbox is kept apart", split.uncategorized.map((i) => i.email), ["d@smtp.io"]);
eq("…and said out loud", C.describeSplit(split), "Google Inboxes ×1 · Azure 25 ×1 · Azure 50 ×2 · 1 uncategorised");
eq("a clean batch says only its kinds",
  C.describeSplit(C.splitByCategory(batch.filter((i) => i.category))), "Google Inboxes ×1 · Azure 25 ×1 · Azure 50 ×2");
eq("an empty batch splits into nothing", C.splitByCategory([]), { groups: [], uncategorized: [] });

// --- the saved settings -------------------------------------------------------
console.log("--- the settings");
eq("every category has both weeks",
  C.CATEGORIES.map((c) => Object.keys(W.DEFAULT_OUTREACH_SETTINGS[c]).sort()),
  [["week1", "week2"], ["week1", "week2"], ["week1", "week2"]]);
eq("a week is a batch's worth of days", W.WEEK_LENGTH_DAYS, 7);
eq("the defaults are all valid", W.validateSettings(W.DEFAULT_OUTREACH_SETTINGS), []);
// A file written before a category existed still has to read.
const partial = W.normalizeSettings({ google: { week1: { campaignEmails: "5" } } });
eq("a missing week falls back to the default", partial.google.week2, W.DEFAULT_OUTREACH_SETTINGS.google.week2);
eq("…and a missing category too", partial.azure50, W.DEFAULT_OUTREACH_SETTINGS.azure50);
eq("a week keeps only the five known fields, as strings",
  partial.google.week1, { campaignEmails: "5", warmupEmails: "", randomize: "", warmupReplyRate: "", intervalMinutes: "" });
eq("junk normalizes to the defaults, not to a crash",
  W.normalizeSettings(null).azure25, W.DEFAULT_OUTREACH_SETTINGS.azure25);
eq("rubbish in a field is refused, by category and week",
  W.validateSettings(W.normalizeSettings({ azure25: { week2: { campaignEmails: "abc" } } })),
  ["Azure 25 — Week 2: Campaign emails must be a number."]);
eq("…and so is one out of range",
  W.validateSettings(W.normalizeSettings({ google: { week1: { warmupReplyRate: "120" } } })),
  ["Google Inboxes — Week 1: Warmup reply rate must be between 0 and 100 %."]);

// A week with every field blank changes nothing, which is worth saying before
// a switch is scheduled for it.
eq("an all-blank week is empty", W.weekIsEmpty({ campaignEmails: "", warmupEmails: "", randomize: "", warmupReplyRate: "", intervalMinutes: "" }), true);
eq("…and one field is enough to make it not", W.weekIsEmpty({ campaignEmails: "3", warmupEmails: "", randomize: "", warmupReplyRate: "", intervalMinutes: "" }), false);
eq("the categories whose week 2 would do nothing are named",
  W.emptyWeek2(W.normalizeSettings({ azure50: { week2: {} } }), ["google", "azure50"]), ["azure50"]);
eq("a week reads back in words",
  W.describeWeek({ warmupEmails: "27", campaignEmails: "3", randomize: "", warmupReplyRate: "", intervalMinutes: "" }),
  "Warmup emails 27 per day · Campaign emails 3 per day");
eq("…and an empty one says so", W.describeWeek({ campaignEmails: "", warmupEmails: "", randomize: "", warmupReplyRate: "", intervalMinutes: "" }),
  "nothing — every field is blank");

// --- when the switch lands ----------------------------------------------------
console.log("--- the clock");
eq("six in the morning, Helsinki", [S.SWITCH_HOUR, S.SWITCH_TIMEZONE], [6, "Europe/Helsinki"]);
const local = (ms) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Helsinki", hour12: false,
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
}).format(new Date(ms));
const due = (iso) => local(S.week2DueAt(Date.parse(iso)));
eq("seven days on, at six", due("2026-09-21T10:00:00Z"), "2026-09-28, 06:00");
// Helsinki is EET/EEST, so a fixed number of hours would drift by one across
// a clock change. These two weeks span both transitions.
eq("…still six across the spring forward", due("2026-03-22T10:00:00Z"), "2026-03-29, 06:00");
eq("…and across the autumn back", due("2026-10-18T10:00:00Z"), "2026-10-25, 06:00");
// A run before six in the morning must not land seven days minus a few hours.
eq("a run at 4am local still gets a full seven days", due("2026-09-21T01:00:00Z"), "2026-09-28, 06:00");
eq("the switch is always in the future",
  ["2026-09-21T10:00:00Z", "2026-03-29T01:30:00Z", "2026-12-31T23:59:00Z"]
    .every((iso) => S.week2DueAt(Date.parse(iso)) > Date.parse(iso)), true);
eq("…and always exactly seven days out",
  ["2026-09-21T10:00:00Z", "2026-03-22T10:00:00Z", "2026-10-18T10:00:00Z"]
    .map((iso) => S.daysUntil(S.week2DueAt(Date.parse(iso)), Date.parse(iso))), [7, 7, 7]);
eq("the offset follows the season",
  [S.offsetMs(Date.parse("2026-01-01T00:00:00Z")) / 3600000, S.offsetMs(Date.parse("2026-07-01T00:00:00Z")) / 3600000],
  [2, 3]);
eq("a due date reads as a morning", S.describeDue(Date.parse("2026-09-28T03:00:00Z")), "Mon 28 Sept, 06:00 Helsinki");
eq("days until never goes negative", S.daysUntil(Date.parse("2026-09-01T00:00:00Z"), Date.parse("2026-09-21T00:00:00Z")), 0);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
