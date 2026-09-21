// Unit checks for Find Burned Domains & Inboxes: the thresholds, the verdict,
// the two groupings (inbox for Google, domain for Microsoft) and what comes
// out of a scan. Imports the REAL modules.
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
  ESPS, ESP_LABELS, levelOf, isEsp, DEFAULT_THRESHOLDS, DEFAULT_SETTINGS,
  parseMinSends, parseReplyPct, validateThresholds, normalizeThresholds,
  normalizeSettings, describeThresholds,
} = S;

// --- the two providers -----------------------------------------------------
console.log("--- providers");
eq("two providers, Google and Microsoft", [ESPS, ESPS.map((e) => ESP_LABELS[e])], [["google", "microsoft"], ["Google", "Microsoft"]]);
// The whole point of the overhaul: the level differs by provider.
eq("Google is judged inbox by inbox, Microsoft domain by domain", ESPS.map(levelOf), ["inbox", "domain"]);
eq("anything else is not a provider", [isEsp("google"), isEsp("microsoft"), isEsp("yahoo"), isEsp(null), isEsp(1)], [true, true, false, false, false]);

// --- the thresholds --------------------------------------------------------
console.log("--- thresholds");
eq("the defaults are the bars this app already uses: 1% per inbox, 1.5% per domain",
  [DEFAULT_THRESHOLDS.google, DEFAULT_THRESHOLDS.microsoft],
  [{ minSends: 100, replyOooPct: 1 }, { minSends: 100, replyOooPct: 1.5 }]);
eq("a whole number of sends is fine", [parseMinSends(100).value, parseMinSends("250").value, parseMinSends(0).value], [100, 250, 0]);
// Number("") is 0, and a minimum of 0 would judge every quiet mailbox, so
// blank must be refused rather than read as none.
eq("a blank minimum is refused, not read as zero", parseMinSends("").error, "Minimum sends: enter a number.");
eq("…as are a fraction and a negative", [parseMinSends(12.5).error, parseMinSends(-1).error],
  ["Minimum sends: use a whole number.", "Minimum sends: can't be negative."]);
eq("a percentage may have decimals", [parseReplyPct(1.5).value, parseReplyPct("0.75").value, parseReplyPct(0).value], [1.5, 0.75, 0]);
eq("…rounded to two", parseReplyPct(1.239).value, 1.24);
eq("a percentage over 100 is refused", parseReplyPct(101).error, "Reply % (OOO): must be 100 or less.");
eq("…and a blank one", parseReplyPct("").error, "Reply % (OOO): enter a percentage.");
eq("a good pair has no problems", validateThresholds({ minSends: 100, replyOooPct: 1 }), []);
eq("…and a bad one names both", validateThresholds({ minSends: "", replyOooPct: -1 }),
  ["Minimum sends: enter a number.", "Reply % (OOO): can't be negative."]);
eq("junk falls back to that provider's default", normalizeThresholds({ minSends: "x", replyOooPct: null }, "microsoft"), DEFAULT_THRESHOLDS.microsoft);
eq("…and a good pair reads as itself", normalizeThresholds({ minSends: 40, replyOooPct: 2 }, "google"), { minSends: 40, replyOooPct: 2 });
eq("a stored file with one provider set keeps the other's default",
  normalizeSettings({ thresholds: { google: { minSends: 50, replyOooPct: 0.5 } }, updatedAt: 7 }),
  { thresholds: { google: { minSends: 50, replyOooPct: 0.5 }, microsoft: DEFAULT_THRESHOLDS.microsoft }, updatedAt: 7 });
eq("…and nothing stored reads as the defaults", normalizeSettings(null), { thresholds: DEFAULT_SETTINGS.thresholds, updatedAt: 0 });
// An -s plural would say "inboxs" on the copy button.
eq("a count reads with the right noun", [S.countNoun(1, "google"), S.countNoun(11, "google"), S.countNoun(1, "microsoft"), S.countNoun(2, "microsoft")],
  ["1 inbox", "11 inboxes", "1 domain", "2 domains"]);
eq("…with thousands separated", S.countNoun(1200, "google"), "1,200 inboxes");
eq("the bar reads as a sentence", [describeThresholds("google", { minSends: 100, replyOooPct: 1 }), describeThresholds("microsoft", { minSends: 250, replyOooPct: 1.5 })],
  ["Google inboxes · under 1% reply (OOO) on 100+ sends", "Microsoft domains · under 1.5% reply (OOO) on 250+ sends"]);

// --- the verdict -----------------------------------------------------------
console.log("--- the verdict");
const scan = await importTs("@/lib/burned/scan");
const { judge, rowsForInboxes, rowsForDomains, rowsFor, countRows, sortRows, copyText, toCsv, csvName, CSV_HEADERS } = scan;
const T = { minSends: 100, replyOooPct: 1 };
eq("under the bar with enough sends is burned", judge({ sent: 500, replyRateOoo: 0.4, hasFigures: true }, T), { verdict: "burned" });
eq("at the bar is not", judge({ sent: 500, replyRateOoo: 1, hasFigures: true }, T), { verdict: "ok" });
eq("…nor above it", judge({ sent: 500, replyRateOoo: 3.2, hasFigures: true }, T), { verdict: "ok" });
eq("too few sends is not judged", judge({ sent: 99, replyRateOoo: 0, hasFigures: true }, T), { verdict: "quiet", reason: "few-sends" });
eq("…and exactly the minimum is", judge({ sent: 100, replyRateOoo: 0, hasFigures: true }, T), { verdict: "burned" });
// Naming something burned on no evidence would have someone replace a domain
// that was never sending.
eq("no figures is never burned", judge({ sent: 0, replyRateOoo: 0, hasFigures: false }, T), { verdict: "quiet", reason: "no-figures" });
eq("…even with sends reported", judge({ sent: 9999, replyRateOoo: 0, hasFigures: false }, T), { verdict: "quiet", reason: "no-figures" });

// --- Google: one row per inbox ---------------------------------------------
console.log("--- Google, inbox by inbox");
const WS = { workspaceId: "ws1", workspaceName: "Media Manager" };
const inbox = (email, id) => ({ id, email, provider: "GOOGLE_WORKSPACE" });
const stat = (id, email, o) => ({ id, email, sent: 0, contacted: 0, replies: 0, oooReplies: 0, replyRate: 0, replyRateOoo: 0, ...o });
const index = (rows) => new Map(rows.flatMap((r) => [[r.id, r], [r.email, r]]));

const gInboxes = [inbox("a@x.com", "i1"), inbox("b@x.com", "i2"), inbox("c@y.com", "i3"), inbox("d@y.com", "i4")];
const gStats = index([
  // 1 reply + 1 OOO over 200 contacted = 1% — at the bar, so kept.
  stat("i1", "a@x.com", { sent: 600, contacted: 200, replies: 1, oooReplies: 1 }),
  // Nothing at all over 300 contacted: burned.
  stat("i2", "b@x.com", { sent: 900, contacted: 300, replies: 0, oooReplies: 0 }),
  // Barely sent: not judged.
  stat("i3", "c@y.com", { sent: 40, contacted: 20, replies: 0, oooReplies: 0 }),
  // i4 has no stats row at all.
]);
const gRows = rowsForInboxes(WS, gInboxes, gStats, T);
eq("one row per inbox, whatever their domains", gRows.map((r) => r.name), ["a@x.com", "b@x.com", "c@y.com", "d@y.com"]);
eq("…each carrying its domain, so a burned inbox says where it lives", gRows.map((r) => r.domain), ["x.com", "x.com", "y.com", "y.com"]);
eq("…and counting as one inbox", gRows.map((r) => r.inboxes), [1, 1, 1, 1]);
eq("the verdicts", gRows.map((r) => [r.verdict, r.reason ?? null]), [["ok", null], ["burned", null], ["quiet", "few-sends"], ["quiet", "no-figures"]]);
// Rates are replies over UNIQUE CONTACTED, not over sends: 2/200 is 1%, while
// over 600 sends it would read as 0.33% and the inbox would be called burned.
eq("rates are over unique leads contacted, not sends", [gRows[0].replyRate, gRows[0].replyRateOoo], [0.5, 1]);
eq("an inbox with no figures reads as zeroes", [gRows[3].sent, gRows[3].replyRateOoo], [0, 0]);

// --- Microsoft: one row per domain -----------------------------------------
console.log("--- Microsoft, domain by domain");
const mInboxes = [
  { id: "m1", email: "a@burned.com" }, { id: "m2", email: "b@burned.com" },
  { id: "m3", email: "a@good.com" }, { id: "m4", email: "b@good.com" },
  { id: "m5", email: "a@quiet.com" },
];
const mStats = index([
  stat("m1", "a@burned.com", { sent: 400, contacted: 200, replies: 0, oooReplies: 1 }),
  stat("m2", "b@burned.com", { sent: 400, contacted: 200, replies: 1, oooReplies: 0 }),
  // One mailbox is dead, the other is not; summed the domain still clears it.
  stat("m3", "a@good.com", { sent: 500, contacted: 250, replies: 0, oooReplies: 0 }),
  stat("m4", "b@good.com", { sent: 500, contacted: 250, replies: 20, oooReplies: 5 }),
  stat("m5", "a@quiet.com", { sent: 10, contacted: 5, replies: 0, oooReplies: 0 }),
]);
const mRows = rowsForDomains(WS, mInboxes, mStats, { minSends: 100, replyOooPct: 1.5 });
eq("one row per domain, in the order first met", mRows.map((r) => r.name), ["burned.com", "good.com", "quiet.com"]);
eq("…counting the mailboxes behind it", mRows.map((r) => r.inboxes), [2, 2, 1]);
// 2 replies over 400 contacted is 0.5%: under 1.5%, so the domain is burned.
eq("the domain is summed across its inboxes, never averaged", [mRows[0].sent, mRows[0].contacted, mRows[0].replyRateOoo, mRows[0].verdict], [800, 400, 0.5, "burned"]);
// A mailbox that sent 5 emails and got a reply must not outweigh one that
// sent 500 and got none: 25 over 500 is 5%.
eq("…so one dead mailbox does not burn a domain that is still replying", [mRows[1].replyRateOoo, mRows[1].verdict], [5, "ok"]);
eq("a domain under the minimum is not judged", [mRows[2].verdict, mRows[2].reason], ["quiet", "few-sends"]);
eq("a domain with no figures at all is not judged either",
  rowsForDomains(WS, [{ id: "z1", email: "a@nothing.com" }], new Map(), T).map((r) => [r.verdict, r.reason, r.sent]), [["quiet", "no-figures", 0]]);
eq("an address with no domain is left out rather than grouped under ''", rowsForDomains(WS, [{ id: "z", email: "not-an-address" }], new Map(), T), []);

// The same call picks the grouping from the provider — what the job relies on.
eq("rowsFor picks the grouping from the provider",
  [rowsFor("google", WS, mInboxes, mStats, T).length, rowsFor("microsoft", WS, mInboxes, mStats, T).length], [5, 3]);

// --- counting, ordering and what comes out ---------------------------------
console.log("--- the list");
eq("the counts split every row exactly once", countRows(gRows), { scanned: 4, burned: 1, ok: 1, fewSends: 1, noFigures: 1 });
const sorted = sortRows([...gRows, ...mRows]);
eq("burned first, then the rest", sorted.map((r) => r.verdict), ["burned", "burned", "ok", "ok", "quiet", "quiet", "quiet"]);
eq("…worst reply rate first within burned", sorted.slice(0, 2).map((r) => [r.name, r.replyRateOoo]), [["b@x.com", 0], ["burned.com", 0.5]]);
eq("copy is the names, one per line", copyText(sorted.slice(0, 2)), "b@x.com\nburned.com");
eq("nothing to copy is an empty string", copyText([]), "");

const csv = toCsv([mRows[0], mRows[2]]);
const lines = csv.split("\n");
eq("the CSV leads with its headers", lines[0], CSV_HEADERS.join(","));
eq("…a row per entry", lines.length, 3);
eq("…with the figures in order: 1 reply of 400 contacted is 0.25%, plus the OOO 0.5%", lines[1], "Media Manager,burned.com,burned.com,2,800,400,1,1,0.25,0.5,burned");
eq("…and a quiet row saying why, in words", lines[2].endsWith(",too few sends"), true);
eq("a comma in a workspace name is quoted, not left to split the row",
  toCsv([{ ...mRows[0], workspaceName: 'Acme, Inc "HQ"' }]).split("\n")[1].startsWith('"Acme, Inc ""HQ""",burned.com'), true);
eq("the file is named for the provider and the window", [csvName("google", "2026-09-21"), csvName("microsoft", "2026-09-21")],
  ["burned-google-inboxes-2026-09-21.csv", "burned-microsoft-domains-2026-09-21.csv"]);

console.log(failures === 0 ? "\nall burned checks OK" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
