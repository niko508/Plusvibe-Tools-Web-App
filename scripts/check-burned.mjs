// Unit checks for Find Burned Domains & Inboxes: the thresholds, the verdict
// against the rest of the workspace, the two groupings (inbox for Google,
// domain for Microsoft), what comes out of a scan, and when the weekly run
// happens. Imports the REAL modules.
//
//   node scripts/check-burned.mjs

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

const S = await importTs("@/lib/burned/settings");
const {
  ESPS, ESP_LABELS, levelOf, isEsp, DEFAULT_THRESHOLDS, DEFAULT_SETTINGS, DEFAULT_SCHEDULE,
  parseMinSends, parseMinDays, parseRelativePct, validateThresholds, normalizeThresholds,
  normalizeSettings, normalizeSchedule, describeThresholds,
} = S;

// --- the two providers -----------------------------------------------------
console.log("--- providers");
eq("two providers, Google and Microsoft", [ESPS, ESPS.map((e) => ESP_LABELS[e])], [["google", "microsoft"], ["Google", "Microsoft"]]);
eq("Google is judged inbox by inbox, Microsoft domain by domain", ESPS.map(levelOf), ["inbox", "domain"]);
eq("anything else is not a provider", [isEsp("google"), isEsp("microsoft"), isEsp("yahoo"), isEsp(null), isEsp(1)], [true, true, false, false, false]);

// --- the thresholds --------------------------------------------------------
console.log("--- thresholds");
eq("the defaults: Google inboxes 300 sends, Microsoft domains 750, both 14 days and half the workspace",
  [DEFAULT_THRESHOLDS.google, DEFAULT_THRESHOLDS.microsoft],
  [{ minSends: 300, minDays: 14, relativePct: 50 }, { minSends: 750, minDays: 14, relativePct: 50 }]);
eq("a whole number of sends is fine", [parseMinSends(100).value, parseMinSends("250").value, parseMinSends(0).value], [100, 250, 0]);
// Number("") is 0, and a minimum of 0 would judge every quiet mailbox, so
// blank must be refused rather than read as none.
eq("a blank minimum is refused, not read as zero", parseMinSends("").error, "Minimum sends: enter a number.");
eq("…as are a fraction and a negative", [parseMinSends(12.5).error, parseMinSends(-1).error],
  ["Minimum sends: use a whole number.", "Minimum sends: can't be negative."]);
eq("days are whole, 0 to 90", [parseMinDays(14).value, parseMinDays("0").value, parseMinDays(1.5).error, parseMinDays(91).error],
  [14, 0, "Minimum days: use a whole number.", "Minimum days: 90 is the most."]);
eq("the share of the workspace may have decimals", [parseRelativePct(50).value, parseRelativePct("37.5").value], [50, 37.5]);
// 0% would burn nothing at all, which is the schedule quietly doing nothing.
eq("…but 0 and over 100 are refused", [parseRelativePct(0).error, parseRelativePct(101).error],
  ["% of workspace: must be more than 0.", "% of workspace: must be 100 or less."]);
eq("a good set has no problems", validateThresholds({ minSends: 750, minDays: 14, relativePct: 50 }), []);
eq("…and a bad one names each, in reading order", validateThresholds({ minSends: "", minDays: -1, relativePct: 0 }),
  ["Minimum sends: enter a number.", "Minimum days: can't be negative.", "% of workspace: must be more than 0."]);
eq("junk falls back to that provider's default", normalizeThresholds({ minSends: "x", minDays: null, relativePct: "y" }, "microsoft"), DEFAULT_THRESHOLDS.microsoft);
eq("…and a good set reads as itself", normalizeThresholds({ minSends: 400, minDays: 21, relativePct: 40 }, "google"), { minSends: 400, minDays: 21, relativePct: 40 });
// The old fixed-bar rule's minimum sends was 100 — far too few for the new
// rule — so a file from before is read whole as the new defaults.
eq("a stored set from the old fixed-bar rule reads as the defaults",
  normalizeThresholds({ minSends: 100, replyOooPct: 1.5, replyPct: 0.5 }, "microsoft"), DEFAULT_THRESHOLDS.microsoft);
eq("a stored file with one provider set keeps the other's default",
  normalizeSettings({ thresholds: { google: { minSends: 500, minDays: 7, relativePct: 60 } }, updatedAt: 7 }),
  { thresholds: { google: { minSends: 500, minDays: 7, relativePct: 60 }, microsoft: DEFAULT_THRESHOLDS.microsoft }, schedule: DEFAULT_SCHEDULE, updatedAt: 7 });
eq("…and nothing stored reads as the defaults, schedule off and report only",
  normalizeSettings(null), { thresholds: DEFAULT_SETTINGS.thresholds, schedule: { enabled: false, mode: "report", sheetUrl: "" }, updatedAt: 0 });
eq("the schedule reads what it can", [normalizeSchedule({ enabled: true, mode: "remove", sheetUrl: " x " }), normalizeSchedule({ enabled: "yes", mode: "nuke" })],
  [{ enabled: true, mode: "remove", sheetUrl: "x" }, { enabled: false, mode: "report", sheetUrl: "" }]);
eq("a count reads with the right noun", [S.countNoun(1, "google"), S.countNoun(11, "google"), S.countNoun(1, "microsoft"), S.countNoun(2, "microsoft")],
  ["1 inbox", "11 inboxes", "1 domain", "2 domains"]);
eq("the bar reads as a sentence", describeThresholds("microsoft", DEFAULT_THRESHOLDS.microsoft),
  "Microsoft domains · under 50% of their workspace's reply rate, on 750+ sends and 14+ days");

// --- first send, from the daily chart --------------------------------------
console.log("--- first send");
const P = await importTs("@/lib/blocked-domains/performance");
eq("the first day with a send, whatever order the chart is in",
  P.firstSendOf([{ date: "2026-10-12", total_sent_count: 4 }, { date: "2026-10-10", total_sent_count: 0 }, { date: "2026-10-11", total_sent_count: 2 }]), "2026-10-11");
eq("…reading a timestamp as its date", P.firstSendOf([{ date: "2026-10-11T00:00:00.000Z", total_sent_count: "3" }]), "2026-10-11");
eq("no sends, no chart, or junk dates give nothing", [P.firstSendOf([{ date: "2026-10-11", total_sent_count: 0 }]), P.firstSendOf(undefined), P.firstSendOf([{ date: "soon", total_sent_count: 5 }])],
  [undefined, undefined, undefined]);
eq("a stats row carries it when the chart came back",
  P.readStatsRow({ email_acc_id: "i1", email: "a@x.com", header: { total_sent_count: 9 }, chart: [{ date: "2026-10-01", total_sent_count: 9 }] }).firstSend, "2026-10-01");
eq("…and leaves it out when not", "firstSend" in P.readStatsRow({ email_acc_id: "i1", email: "a@x.com", header: {} }), false);

// --- the verdict -----------------------------------------------------------
console.log("--- the verdict");
const scan = await importTs("@/lib/burned/scan");
const { judge, daysBetween, baselineExcluding, rowsForInboxes, rowsForDomains, rowsFor, countRows, sortRows, copyText, toCsv, csvName, CSV_HEADERS, verdictText } = scan;
const T = { minSends: 750, minDays: 14, relativePct: 50 };
const B = { sent: 10000, replyRate: 1, replyRateOoo: 2 };
const j = (o) => judge({ sent: 1000, days: 30, replyRate: 0, replyRateOoo: 0, hasFigures: true, baseline: B, ...o }, T);
eq("days count both ends", [daysBetween("2026-10-01", "2026-10-14"), daysBetween("2026-10-14", "2026-10-14"), daysBetween("x", "2026-10-14")], [14, 1, null]);
eq("under half the workspace on both rates is burned", j({ replyRateOoo: 0.9, replyRate: 0.4 }), { verdict: "burned" });
eq("exactly half the workspace's OOO rate is not", j({ replyRateOoo: 1, replyRate: 0 }), { verdict: "ok" });
// Real replies overrule a low OOO figure: something people answer is not burned.
eq("real replies at half the workspace's real rate keep it", j({ replyRateOoo: 0.6, replyRate: 0.5 }), { verdict: "ok", rescued: true });
eq("…but just under does not", j({ replyRateOoo: 0.6, replyRate: 0.49 }), { verdict: "burned" });
eq("the same row is fine in a weaker workspace", j({ replyRateOoo: 0.9, replyRate: 0.4, baseline: { sent: 10000, replyRate: 0.5, replyRateOoo: 1.5 } }), { verdict: "ok" });
eq("too few sends is not judged, whatever the rates", j({ sent: 749 }), { verdict: "quiet", reason: "few-sends" });
eq("…and exactly the minimum is", j({ sent: 750 }), { verdict: "burned" });
eq("13 days of outreach is too new", j({ days: 13 }), { verdict: "quiet", reason: "too-new" });
eq("…14 is enough", j({ days: 14 }), { verdict: "burned" });
eq("no daily figures to say since when is not judged", j({ days: null }), { verdict: "quiet", reason: "no-history" });
eq("a workspace with nothing else on the provider has nothing to compare with", j({ baseline: null }), { verdict: "quiet", reason: "no-baseline" });
eq("…nor one whose rest sent under the minimum", j({ baseline: { ...B, sent: 500 } }), { verdict: "quiet", reason: "no-baseline" });
eq("…nor one where nobody replied at all", j({ baseline: { ...B, replyRate: 0, replyRateOoo: 0 } }), { verdict: "quiet", reason: "no-baseline" });
// Naming something burned on no evidence would have someone replace a domain
// that was never sending.
eq("no figures is never burned", j({ hasFigures: false, sent: 9999 }), { verdict: "quiet", reason: "no-figures" });
eq("the rest of the workspace is counted, not averaged, and leaves the row out",
  baselineExcluding([
    { sent: 1000, contacted: 500, replies: 5, oooReplies: 5, hasFigures: true },
    { sent: 3000, contacted: 1000, replies: 10, oooReplies: 10, hasFigures: true },
    { sent: 100, contacted: 100, replies: 9, oooReplies: 0, hasFigures: true },
  ], 0), { sent: 3100, replyRate: 1.73, replyRateOoo: 2.64 });
eq("…and with nothing contacted there is no baseline", baselineExcluding([{ sent: 10, contacted: 0, replies: 0, oooReplies: 0, hasFigures: true }, { sent: 10, contacted: 0, replies: 0, oooReplies: 0, hasFigures: true }], 0), null);

// --- Google: one row per inbox ---------------------------------------------
console.log("--- Google, inbox by inbox");
const WS = { workspaceId: "ws1", workspaceName: "Media Manager" };
const END = "2026-11-08";
const inbox = (email, id) => ({ id, email, provider: "GOOGLE_WORKSPACE" });
const stat = (id, email, o) => ({ id, email, sent: 0, contacted: 0, replies: 0, oooReplies: 0, replyRate: 0, replyRateOoo: 0, firstSend: "2026-10-10", ...o });
const index = (rows) => new Map(rows.flatMap((r) => [[r.id, r], [r.email, r]]));
const GT = { minSends: 300, minDays: 14, relativePct: 50 };

const gInboxes = [inbox("a@x.com", "i1"), inbox("b@x.com", "i2"), inbox("c@y.com", "i3"), inbox("d@y.com", "i4"), inbox("e@y.com", "i5"), inbox("f@y.com", "i6")];
const gStats = index([
  // 8 replies + 8 OOO over 400 contacted = 4%: the healthy ones.
  stat("i1", "a@x.com", { sent: 900, contacted: 400, replies: 8, oooReplies: 8 }),
  // Nothing at all over 300 contacted: burned.
  stat("i2", "b@x.com", { sent: 600, contacted: 300, replies: 0, oooReplies: 0 }),
  // Barely sent: not judged.
  stat("i3", "c@y.com", { sent: 40, contacted: 20, replies: 0, oooReplies: 0 }),
  // i4 has no stats row at all.
  // Plenty of sends but only started 5 days before the end: too new.
  stat("i5", "e@y.com", { sent: 400, contacted: 300, replies: 0, oooReplies: 0, firstSend: "2026-11-04" }),
  stat("i6", "f@y.com", { sent: 900, contacted: 400, replies: 6, oooReplies: 6 }),
]);
const gRows = rowsForInboxes(WS, gInboxes, gStats, GT, END);
eq("one row per inbox, whatever their domains", gRows.map((r) => r.name), ["a@x.com", "b@x.com", "c@y.com", "d@y.com", "e@y.com", "f@y.com"]);
eq("…each carrying its domain, so a burned inbox says where it lives", gRows.map((r) => r.domain), ["x.com", "x.com", "y.com", "y.com", "y.com", "y.com"]);
eq("the verdicts", gRows.map((r) => [r.verdict, r.reason ?? null]),
  [["ok", null], ["burned", null], ["quiet", "few-sends"], ["quiet", "no-figures"], ["quiet", "too-new"], ["ok", null]]);
eq("rates are over unique leads contacted, not sends", [gRows[0].replyRate, gRows[0].replyRateOoo], [2, 4]);
// The rest for b@x.com: 14 + 14 over 1,120 contacted.
eq("each row carries the rest of its workspace and its share of it",
  [gRows[1].baseline, gRows[1].vsWorkspace, gRows[0].vsWorkspace], [{ sent: 2240, replyRate: 1.25, replyRateOoo: 2.5 }, 0, 339]);
eq("…and its days of outreach", gRows.map((r) => r.days ?? null), [30, 30, 30, null, 5, 30]);

// --- Microsoft: one row per domain -----------------------------------------
console.log("--- Microsoft, domain by domain");
const mInboxes = [
  { id: "m1", email: "a@burned.com" }, { id: "m2", email: "b@burned.com" },
  { id: "m3", email: "a@good.com" }, { id: "m4", email: "b@good.com" },
  { id: "m5", email: "a@quiet.com" },
  { id: "m6", email: "a@replying.com" },
];
const mStats = index([
  stat("m1", "a@burned.com", { sent: 500, contacted: 250, replies: 0, oooReplies: 1 }),
  stat("m2", "b@burned.com", { sent: 500, contacted: 250, replies: 1, oooReplies: 0, firstSend: "2026-10-01" }),
  // One mailbox is dead, the other is not; summed the domain still clears it.
  stat("m3", "a@good.com", { sent: 1000, contacted: 500, replies: 0, oooReplies: 0 }),
  stat("m4", "b@good.com", { sent: 1000, contacted: 500, replies: 20, oooReplies: 20 }),
  stat("m5", "a@quiet.com", { sent: 10, contacted: 5, replies: 0, oooReplies: 0 }),
  // Real replies, no auto-replies: under half the workspace on OOO, but its
  // real rate clears half of theirs, so it is kept.
  stat("m6", "a@replying.com", { sent: 1600, contacted: 800, replies: 8, oooReplies: 0 }),
]);
const mRows = rowsForDomains(WS, mInboxes, mStats, T, END);
eq("one row per domain, in the order first met", mRows.map((r) => r.name), ["burned.com", "good.com", "quiet.com", "replying.com"]);
eq("…counting the mailboxes behind it", mRows.map((r) => r.inboxes), [2, 2, 1, 1]);
eq("the domain is summed across its inboxes, never averaged", [mRows[0].sent, mRows[0].contacted, mRows[0].replyRateOoo, mRows[0].verdict], [1000, 500, 0.4, "burned"]);
eq("…its first send is its earliest mailbox's", mRows[0].days, 39);
eq("…so one dead mailbox does not burn a domain that is still replying", [mRows[1].replyRateOoo, mRows[1].verdict], [4, "ok"]);
eq("a domain under the minimum is not judged", [mRows[2].verdict, mRows[2].reason], ["quiet", "few-sends"]);
eq("a domain answering for real is kept", [mRows[3].verdict, mRows[3].rescued ?? null], ["ok", true]);
eq("a domain with no figures at all is not judged",
  rowsForDomains(WS, [{ id: "z1", email: "a@nothing.com" }], new Map(), T, END).map((r) => [r.verdict, r.reason, r.sent]), [["quiet", "no-figures", 0]]);
eq("a workspace's only domain has nothing to compare with",
  rowsForDomains(WS, [mInboxes[0], mInboxes[1]], mStats, T, END).map((r) => [r.verdict, r.reason]), [["quiet", "no-baseline"]]);
eq("an address with no domain is left out rather than grouped under ''", rowsForDomains(WS, [{ id: "z", email: "not-an-address" }], new Map(), T, END), []);
eq("rowsFor picks the grouping from the provider",
  [rowsFor("google", WS, mInboxes, mStats, T, END).length, rowsFor("microsoft", WS, mInboxes, mStats, T, END).length], [6, 4]);

// --- counting, ordering and what comes out ---------------------------------
console.log("--- the list");
eq("the counts split every row exactly once",
  countRows(gRows), { scanned: 6, burned: 1, ok: 2, rescued: 0, fewSends: 1, tooNew: 1, noBaseline: 0, noFigures: 1 });
const sorted = sortRows([...gRows, ...mRows]);
eq("burned first, then the rest", sorted.map((r) => r.verdict), ["burned", "burned", "ok", "ok", "ok", "ok", "quiet", "quiet", "quiet", "quiet"]);
eq("…furthest under its workspace first", sorted.slice(0, 2).map((r) => [r.name, r.vsWorkspace]), [["b@x.com", 0], ["burned.com", 15]]);
eq("copy is the names, one per line", copyText(sorted.slice(0, 2)), "b@x.com\nburned.com");

const csv = toCsv([mRows[0], mRows[2]]);
const lines = csv.split("\n");
eq("the CSV leads with its headers", lines[0], CSV_HEADERS.join(","));
eq("…with the figures and the workspace beside them", lines[1], "Media Manager,burned.com,burned.com,2,1000,500,1,1,0.2,0.4,1.55,2.66,15,39,burned");
eq("…and a quiet row saying why, in words", lines[2].endsWith(",too few sends"), true);
eq("every reason reads in words", ["few-sends", "too-new", "no-history", "no-baseline", "no-figures"].map((reason) => verdictText({ verdict: "quiet", reason })),
  ["too few sends", "sending too few days", "no daily figures", "nothing in the workspace to compare with", "no figures"]);
eq("a comma in a workspace name is quoted, not left to split the row",
  toCsv([{ ...mRows[0], workspaceName: 'Acme, Inc "HQ"' }]).split("\n")[1].startsWith('"Acme, Inc ""HQ""",burned.com'), true);
eq("the file is named for the provider and the window", [csvName("google", "2026-09-21"), csvName("microsoft", "2026-09-21")],
  ["burned-google-inboxes-2026-09-21.csv", "burned-microsoft-domains-2026-09-21.csv"]);

// --- the weekly run --------------------------------------------------------
console.log("--- the weekly run");
const W = await importTs("@/lib/burned/schedule");
// Wed 11 Nov 2026, 12:00 UTC = 14:00 Helsinki (EET, +2).
const WED = Date.UTC(2026, 10, 11, 12, 0, 0);
const MON_DUE = Date.UTC(2026, 10, 9, 4, 0, 0); // Mon 9 Nov 06:00 Helsinki
eq("the week is named by its Monday", [W.weekOf(WED), W.weekOf(MON_DUE), W.weekOf(MON_DUE - 1)], ["2026-11-09", "2026-11-09", "2026-11-09"]);
eq("…a Sunday belongs to the week before", W.weekOf(Date.UTC(2026, 10, 8, 20, 0, 0)), "2026-11-02");
eq("this week's run is Monday 06:00 Helsinki", W.dueThisWeek(WED), MON_DUE);
eq("due once past it and not run this week", [W.isDue(WED, undefined), W.isDue(WED, "2026-11-02"), W.isDue(WED, "2026-11-09")], [true, true, false]);
eq("…not before Monday 06:00", W.isDue(MON_DUE - 60_000, "2026-11-02"), false);
eq("the next run after this week's is next Monday 06:00", W.nextRunAt(WED, "2026-11-09"), Date.UTC(2026, 10, 16, 4, 0, 0));
eq("…before Monday 06:00 it is this Monday", W.nextRunAt(MON_DUE - 60_000, "2026-11-02"), MON_DUE);
eq("…and a missed run is due now", W.nextRunAt(WED, "2026-11-02"), WED);
// Summer time: Helsinki is +3, so 06:00 is 03:00 UTC.
eq("it stays at 06:00 Helsinki in summer", W.dueThisWeek(Date.UTC(2026, 5, 10, 12, 0, 0)), Date.UTC(2026, 5, 8, 3, 0, 0));
eq("the window is the 30 days that ended yesterday", W.windowFor(MON_DUE + 60_000), { start: "2026-10-10", end: "2026-11-08" });
eq("removal is allowed for a normal week", [W.removalGuard(0, 0), W.removalGuard(5, 10), W.removalGuard(20, 400)], [null, null, null]);
eq("…and refused when an implausible share came out burned", typeof W.removalGuard(30, 100), "string");

console.log(failures === 0 ? "\nall burned checks OK" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
