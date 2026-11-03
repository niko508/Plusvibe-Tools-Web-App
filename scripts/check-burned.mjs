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
  parseMinSends, parseReplyOooPct, parseReplyPct, validateThresholds, normalizeThresholds,
  normalizeSettings, describeThresholds, rescueImpossible,
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
  [{ minSends: 100, replyOooPct: 1, replyPct: 0.5 }, { minSends: 100, replyOooPct: 1.5, replyPct: 0.5 }]);
// The rescue only bites below the OOO bar, so the defaults leave it room.
eq("…with the rescue set below the OOO bar on both", ESPS.map((e) => rescueImpossible(DEFAULT_THRESHOLDS[e])), [false, false]);
eq("a whole number of sends is fine", [parseMinSends(100).value, parseMinSends("250").value, parseMinSends(0).value], [100, 250, 0]);
// Number("") is 0, and a minimum of 0 would judge every quiet mailbox, so
// blank must be refused rather than read as none.
eq("a blank minimum is refused, not read as zero", parseMinSends("").error, "Minimum sends: enter a number.");
eq("…as are a fraction and a negative", [parseMinSends(12.5).error, parseMinSends(-1).error],
  ["Minimum sends: use a whole number.", "Minimum sends: can't be negative."]);
eq("a percentage may have decimals", [parseReplyPct(1.5).value, parseReplyPct("0.75").value, parseReplyPct(0).value], [1.5, 0.75, 0]);
eq("…rounded to two", parseReplyPct(1.239).value, 1.24);
eq("a percentage over 100 is refused", parseReplyOooPct(101).error, "Reply % (OOO): must be 100 or less.");
eq("…and a blank one", parseReplyOooPct("").error, "Reply % (OOO): enter a percentage.");
// Each bar names itself, so a problem says which box to look at.
eq("the two reply bars name themselves apart", [parseReplyOooPct("").error, parseReplyPct("").error],
  ["Reply % (OOO): enter a percentage.", "Reply %: enter a percentage."]);
eq("a good set has no problems", validateThresholds({ minSends: 100, replyOooPct: 1, replyPct: 0.5 }), []);
eq("…and a bad one names each", validateThresholds({ minSends: "", replyOooPct: -1, replyPct: 200 }),
  ["Minimum sends: enter a number.", "Reply % (OOO): can't be negative.", "Reply %: must be 100 or less."]);
eq("junk falls back to that provider's default", normalizeThresholds({ minSends: "x", replyOooPct: null }, "microsoft"), DEFAULT_THRESHOLDS.microsoft);
eq("…and a good set reads as itself", normalizeThresholds({ minSends: 40, replyOooPct: 2, replyPct: 1 }, "google"), { minSends: 40, replyOooPct: 2, replyPct: 1 });
// A scan saved before the rescue existed has no Reply % at all.
eq("a stored set from before the rescue takes the provider's default for it",
  normalizeThresholds({ minSends: 40, replyOooPct: 2 }, "google"), { minSends: 40, replyOooPct: 2, replyPct: 0.5 });
eq("a stored file with one provider set keeps the other's default",
  normalizeSettings({ thresholds: { google: { minSends: 50, replyOooPct: 0.5, replyPct: 0.25 } }, updatedAt: 7 }),
  { thresholds: { google: { minSends: 50, replyOooPct: 0.5, replyPct: 0.25 }, microsoft: DEFAULT_THRESHOLDS.microsoft }, updatedAt: 7 });
// The OOO rate counts the same replies plus the auto-replies, so it is never
// the lower of the two; a Reply % bar at or above it can never fire.
eq("the rescue is impossible at or above the OOO bar",
  [rescueImpossible({ replyPct: 1, replyOooPct: 1 }), rescueImpossible({ replyPct: 2, replyOooPct: 1 }), rescueImpossible({ replyPct: 0.9, replyOooPct: 1 })],
  [true, true, false]);
eq("…and nothing stored reads as the defaults", normalizeSettings(null), { thresholds: DEFAULT_SETTINGS.thresholds, updatedAt: 0 });
// An -s plural would say "inboxs" on the copy button.
eq("a count reads with the right noun", [S.countNoun(1, "google"), S.countNoun(11, "google"), S.countNoun(1, "microsoft"), S.countNoun(2, "microsoft")],
  ["1 inbox", "11 inboxes", "1 domain", "2 domains"]);
eq("…with thousands separated", S.countNoun(1200, "google"), "1,200 inboxes");
eq("the bar reads as a sentence", [describeThresholds("google", { minSends: 100, replyOooPct: 1, replyPct: 0.5 }), describeThresholds("microsoft", { minSends: 250, replyOooPct: 1.5, replyPct: 0.75 })],
  ["Google inboxes · under 1% reply (OOO) and under 0.5% reply on 100+ sends", "Microsoft domains · under 1.5% reply (OOO) and under 0.75% reply on 250+ sends"]);

// --- the verdict -----------------------------------------------------------
console.log("--- the verdict");
const scan = await importTs("@/lib/burned/scan");
const { judge, rowsForInboxes, rowsForDomains, rowsFor, countRows, sortRows, copyText, toCsv, csvName, CSV_HEADERS, verdictText } = scan;
const T = { minSends: 100, replyOooPct: 1, replyPct: 0.5 };
const j = (o) => judge({ sent: 500, replyRate: 0, replyRateOoo: 0, hasFigures: true, ...o }, T);
eq("under both bars with enough sends is burned", j({ replyRateOoo: 0.4, replyRate: 0.1 }), { verdict: "burned" });
eq("at the OOO bar is not", j({ replyRateOoo: 1, replyRate: 0 }), { verdict: "ok" });
eq("…nor above it", j({ replyRateOoo: 3.2, replyRate: 0 }), { verdict: "ok" });
// The rescue: real replies overrule the OOO figure.
eq("real replies at the bar overrule a low OOO figure", j({ replyRateOoo: 0.6, replyRate: 0.5 }), { verdict: "ok", rescued: true });
eq("…and above it", j({ replyRateOoo: 0.9, replyRate: 0.8 }), { verdict: "ok", rescued: true });
eq("…but just under it does not rescue", j({ replyRateOoo: 0.6, replyRate: 0.49 }), { verdict: "burned" });
eq("a row over the OOO bar is ok without being rescued", j({ replyRateOoo: 2, replyRate: 2 }), { verdict: "ok" });
eq("too few sends is not judged, whatever either rate says", judge({ sent: 99, replyRate: 5, replyRateOoo: 5, hasFigures: true }, T), { verdict: "quiet", reason: "few-sends" });
eq("…and exactly the minimum is", judge({ sent: 100, replyRate: 0, replyRateOoo: 0, hasFigures: true }, T), { verdict: "burned" });
// Naming something burned on no evidence would have someone replace a domain
// that was never sending.
eq("no figures is never burned", judge({ sent: 0, replyRate: 0, replyRateOoo: 0, hasFigures: false }, T), { verdict: "quiet", reason: "no-figures" });
eq("…even with sends reported", judge({ sent: 9999, replyRate: 0, replyRateOoo: 0, hasFigures: false }, T), { verdict: "quiet", reason: "no-figures" });
// A bar at or above the OOO one can never fire, since the OOO rate counts the
// same replies plus more — the form says so rather than letting it puzzle.
eq("a rescue bar at the OOO bar changes nothing", judge({ sent: 500, replyRate: 0.9, replyRateOoo: 0.9, hasFigures: true }, { minSends: 100, replyOooPct: 1, replyPct: 1 }), { verdict: "burned" });

// --- Google: one row per inbox ---------------------------------------------
console.log("--- Google, inbox by inbox");
const WS = { workspaceId: "ws1", workspaceName: "Media Manager" };
const inbox = (email, id) => ({ id, email, provider: "GOOGLE_WORKSPACE" });
const stat = (id, email, o) => ({ id, email, sent: 0, contacted: 0, replies: 0, oooReplies: 0, replyRate: 0, replyRateOoo: 0, ...o });
const index = (rows) => new Map(rows.flatMap((r) => [[r.id, r], [r.email, r]]));

const gInboxes = [inbox("a@x.com", "i1"), inbox("b@x.com", "i2"), inbox("c@y.com", "i3"), inbox("d@y.com", "i4"), inbox("e@y.com", "i5")];
const gStats = index([
  // 1 reply + 1 OOO over 200 contacted = 1% — at the bar, so kept.
  stat("i1", "a@x.com", { sent: 600, contacted: 200, replies: 1, oooReplies: 1 }),
  // Nothing at all over 300 contacted: burned.
  stat("i2", "b@x.com", { sent: 900, contacted: 300, replies: 0, oooReplies: 0 }),
  // Barely sent: not judged.
  stat("i3", "c@y.com", { sent: 40, contacted: 20, replies: 0, oooReplies: 0 }),
  // i4 has no stats row at all.
  // Under the OOO bar (0.6%) but its real replies clear 0.5%: rescued. No
  // auto-replies come back, which is exactly the case the OOO bar misjudges.
  stat("i5", "e@y.com", { sent: 700, contacted: 400, replies: 3, oooReplies: 0 }),
]);
const gRows = rowsForInboxes(WS, gInboxes, gStats, T);
eq("one row per inbox, whatever their domains", gRows.map((r) => r.name), ["a@x.com", "b@x.com", "c@y.com", "d@y.com", "e@y.com"]);
eq("…each carrying its domain, so a burned inbox says where it lives", gRows.map((r) => r.domain), ["x.com", "x.com", "y.com", "y.com", "y.com"]);
eq("…and counting as one inbox", gRows.map((r) => r.inboxes), [1, 1, 1, 1, 1]);
eq("the verdicts", gRows.map((r) => [r.verdict, r.reason ?? null]), [["ok", null], ["burned", null], ["quiet", "few-sends"], ["quiet", "no-figures"], ["ok", null]]);
// 3 replies over 400 contacted is 0.75%, and with no auto-replies the OOO
// figure is the same 0.75% — under its 1% bar, so only the rescue keeps it.
eq("an inbox with no auto-replies but real ones is rescued, not burned",
  (() => { const r = gRows[4]; return [r.replyRate, r.replyRateOoo, r.verdict, r.rescued ?? null]; })(), [0.75, 0.75, "ok", true]);
eq("…and the ones over the OOO bar are not marked rescued", gRows[0].rescued ?? null, null);
// Rates are replies over UNIQUE CONTACTED, not over sends: 2/200 is 1%, while
// over 600 sends it would read as 0.33% and the inbox would be called burned.
eq("rates are over unique leads contacted, not sends", [gRows[0].replyRate, gRows[0].replyRateOoo], [0.5, 1]);
eq("an inbox with no figures reads as zeroes", [gRows[3].sent, gRows[3].replyRateOoo], [0, 0]);
// Raise the rescue bar above what it clears and the same inbox burns.
eq("the same inbox burns once the rescue bar is above its real rate",
  rowsForInboxes(WS, [gInboxes[4]], gStats, { ...T, replyPct: 0.8 }).map((r) => [r.verdict, r.rescued ?? null]), [["burned", null]]);

// --- Microsoft: one row per domain -----------------------------------------
console.log("--- Microsoft, domain by domain");
const mInboxes = [
  { id: "m1", email: "a@burned.com" }, { id: "m2", email: "b@burned.com" },
  { id: "m3", email: "a@good.com" }, { id: "m4", email: "b@good.com" },
  { id: "m5", email: "a@quiet.com" },
  { id: "m6", email: "a@replying.com" },
];
const mStats = index([
  stat("m1", "a@burned.com", { sent: 400, contacted: 200, replies: 0, oooReplies: 1 }),
  stat("m2", "b@burned.com", { sent: 400, contacted: 200, replies: 1, oooReplies: 0 }),
  // One mailbox is dead, the other is not; summed the domain still clears it.
  stat("m3", "a@good.com", { sent: 500, contacted: 250, replies: 0, oooReplies: 0 }),
  stat("m4", "b@good.com", { sent: 500, contacted: 250, replies: 20, oooReplies: 5 }),
  stat("m5", "a@quiet.com", { sent: 10, contacted: 5, replies: 0, oooReplies: 0 }),
  // 1% real replies and no auto-replies: under the 1.5% OOO bar, saved by the
  // rescue — a domain people are answering is not burned.
  stat("m6", "a@replying.com", { sent: 600, contacted: 300, replies: 3, oooReplies: 0 }),
]);
const MT = { minSends: 100, replyOooPct: 1.5, replyPct: 1 };
const mRows = rowsForDomains(WS, mInboxes, mStats, MT);
eq("one row per domain, in the order first met", mRows.map((r) => r.name), ["burned.com", "good.com", "quiet.com", "replying.com"]);
eq("…counting the mailboxes behind it", mRows.map((r) => r.inboxes), [2, 2, 1, 1]);
eq("a domain under the OOO bar but answering for real is kept",
  (() => { const r = mRows[3]; return [r.replyRate, r.replyRateOoo, r.verdict, r.rescued ?? null]; })(), [1, 1, "ok", true]);
// 2 replies over 400 contacted is 0.5%: under 1.5%, so the domain is burned.
eq("the domain is summed across its inboxes, never averaged", [mRows[0].sent, mRows[0].contacted, mRows[0].replyRateOoo, mRows[0].verdict], [800, 400, 0.5, "burned"]);
// A mailbox that sent 5 emails and got a reply must not outweigh one that
// sent 500 and got none: 25 over 500 is 5%.
eq("…so one dead mailbox does not burn a domain that is still replying", [mRows[1].replyRateOoo, mRows[1].verdict], [5, "ok"]);
eq("a domain under the minimum is not judged", [mRows[2].verdict, mRows[2].reason], ["quiet", "few-sends"]);
eq("a domain with no figures at all is not judged either",
  rowsForDomains(WS, [{ id: "z1", email: "a@nothing.com" }], new Map(), T).map((r) => [r.verdict, r.reason, r.sent]), [["quiet", "no-figures", 0]]);
eq("…and the rescue never saves one with no figures",
  rowsForDomains(WS, [{ id: "z1", email: "a@nothing.com" }], new Map(), { ...T, replyPct: 0 }).map((r) => r.verdict), ["quiet"]);
eq("an address with no domain is left out rather than grouped under ''", rowsForDomains(WS, [{ id: "z", email: "not-an-address" }], new Map(), T), []);

// The same call picks the grouping from the provider — what the job relies on.
eq("rowsFor picks the grouping from the provider",
  [rowsFor("google", WS, mInboxes, mStats, T).length, rowsFor("microsoft", WS, mInboxes, mStats, T).length], [6, 4]);

// --- counting, ordering and what comes out ---------------------------------
console.log("--- the list");
eq("the counts split every row exactly once, with the rescued ones called out",
  countRows(gRows), { scanned: 5, burned: 1, ok: 2, rescued: 1, fewSends: 1, noFigures: 1 });
const sorted = sortRows([...gRows, ...mRows]);
eq("burned first, then the rest", sorted.map((r) => r.verdict), ["burned", "burned", "ok", "ok", "ok", "ok", "quiet", "quiet", "quiet"]);
eq("…worst reply rate first within burned", sorted.slice(0, 2).map((r) => [r.name, r.replyRateOoo]), [["b@x.com", 0], ["burned.com", 0.5]]);
eq("copy is the names, one per line", copyText(sorted.slice(0, 2)), "b@x.com\nburned.com");
eq("nothing to copy is an empty string", copyText([]), "");

const csv = toCsv([mRows[0], mRows[2]]);
const lines = csv.split("\n");
eq("the CSV leads with its headers", lines[0], CSV_HEADERS.join(","));
eq("…a row per entry", lines.length, 3);
eq("…with the figures in order: 1 reply of 400 contacted is 0.25%, plus the OOO 0.5%", lines[1], "Media Manager,burned.com,burned.com,2,800,400,1,1,0.25,0.5,burned");
eq("…and a quiet row saying why, in words", lines[2].endsWith(",too few sends"), true);
eq("a rescued row says why it was kept", toCsv([mRows[3]]).split("\n")[1].endsWith(",ok — still getting real replies"), true);
eq("…which is what the verdict reads as everywhere", [verdictText(mRows[3]), verdictText(mRows[0]), verdictText(mRows[2])],
  ["ok — still getting real replies", "burned", "too few sends"]);
eq("a comma in a workspace name is quoted, not left to split the row",
  toCsv([{ ...mRows[0], workspaceName: 'Acme, Inc "HQ"' }]).split("\n")[1].startsWith('"Acme, Inc ""HQ""",burned.com'), true);
eq("the file is named for the provider and the window", [csvName("google", "2026-09-21"), csvName("microsoft", "2026-09-21")],
  ["burned-google-inboxes-2026-09-21.csv", "burned-microsoft-domains-2026-09-21.csv"]);

console.log(failures === 0 ? "\nall burned checks OK" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
