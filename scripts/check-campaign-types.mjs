// Unit checks for the Create All Campaign Types pure logic: name derivation,
// the 6-way split, ESP classification, the step-1 spintax append and the
// step-1 sign-off swap.
//
//   node scripts/check-campaign-types.mjs

import { readFileSync } from "fs";
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

// --- names -----------------------------------------------------------------
// The REAL modules, so these checks fail when the shipped logic changes.
const BLUE = "\u{1F535}";
const namesMod = await importTs("@/lib/campaign-types/names");
const { withBlue, withOptOut, withSignature, deriveNames } = namesMod;

console.log("--- names");
// The real naming structure: month in a trailing parenthetical, and no
// separator introduced in front of it.
eq("the real worked example", deriveNames("Tree Removal (August)"), {
  blue: "\u{1F535} Tree Removal (August)",
  optOut: "Tree Removal - Opt Out (August)",
  blueOptOut: "\u{1F535} Tree Removal - Opt Out (August)",
  signature: "Tree Removal - Signature (August)",
  blueSignature: "\u{1F535} Tree Removal - Signature (August)",
});
eq("the user's worked example", deriveNames("Logistics & Warehousing (August)"), {
  blue: "\u{1F535} Logistics & Warehousing (August)",
  optOut: "Logistics & Warehousing - Opt Out (August)",
  blueOptOut: "\u{1F535} Logistics & Warehousing - Opt Out (August)",
  signature: "Logistics & Warehousing - Signature (August)",
  blueSignature: "\u{1F535} Logistics & Warehousing - Signature (August)",
});
eq("signature keeps the parenthetical last",
  deriveNames("Tree Removal (August)").signature.endsWith("(August)"), true);
eq("signature is not doubled", withSignature("Tree Removal - Signature (August)"),
  "Tree Removal - Signature (August)");
eq("signature match is case-insensitive", withSignature("Tree Removal - SIGNATURE (August)"),
  "Tree Removal - SIGNATURE (August)");
eq("signature with no parenthetical appends", withSignature("Tree Removal"),
  "Tree Removal - Signature");
eq("a Signature name is never also an Opt Out name",
  withOptOut(withSignature("Tree Removal (August)")),
  "Tree Removal - Signature - Opt Out (August)");
eq("no dash is introduced before the parenthetical",
  /- \(/.test(deriveNames("Tree Removal (August)").optOut), false);
eq("the parenthetical stays last",
  deriveNames("Tree Removal (August)").optOut.endsWith("(August)"), true);
eq("no parenthetical appends instead", deriveNames("Tree Removal"), {
  blue: "\u{1F535} Tree Removal",
  optOut: "Tree Removal - Opt Out",
  blueOptOut: "\u{1F535} Tree Removal - Opt Out",
  signature: "Tree Removal - Signature",
  blueSignature: "\u{1F535} Tree Removal - Signature",
});
eq("a name that already has a dash keeps it once",
  withOptOut("Tree Removal - UK (August)"), "Tree Removal - UK - Opt Out (August)");
eq("blue is not doubled", withBlue("\u{1F535} Tree Removal (August)"), "\u{1F535} Tree Removal (August)");
eq("opt out is not doubled", withOptOut("Tree Removal - Opt Out (August)"),
  "Tree Removal - Opt Out (August)");
eq("opt out match is case-insensitive", withOptOut("Tree Removal - OPT OUT (August)"),
  "Tree Removal - OPT OUT (August)");
eq("surrounding whitespace trimmed", deriveNames("  Tree Removal (August)  ").optOut,
  "Tree Removal - Opt Out (August)");
eq("multi-word parenthetical preserved", withOptOut("Tree Removal (August 2026)"),
  "Tree Removal - Opt Out (August 2026)");
eq("derived names are all distinct",
  new Set(Object.values(deriveNames("Tree Removal (August)"))).size, 5);
eq("…and none of them is the source name",
  Object.values(deriveNames("Tree Removal (August)")).includes("Tree Removal (August)"), false);
// Applying twice must be a no-op, so a re-run can't stack markers.
eq("derivation is idempotent", withOptOut(withOptOut("Tree Removal (August)")),
  "Tree Removal - Opt Out (August)");
eq("blue idempotent", withBlue(withBlue("Tree Removal (August)")), "\u{1F535} Tree Removal (August)");

// --- split -----------------------------------------------------------------
const { splitCounts, planSplit, splitCountsFor, planSplitFor } =
  await importTs("@/lib/campaign-types/split");
const MS_ROLES = ["blue", "blueOptOut", "blueSignature"];
const OTHER_ROLES = ["source", "optOut", "signature"];
const sum = (c, roles) => roles.reduce((n, r) => n + c[r], 0);

console.log("--- split");
// Opt Out takes half of each bucket, then what is left halves again between
// the campaign it sat in and its Signature copy.
eq("the spec's 20k / 10k example", splitCounts(10000, 10000), {
  source: 2500, optOut: 5000, blue: 2500, blueOptOut: 5000,
  signature: 2500, blueSignature: 2500,
});
eq("no microsoft leads", splitCounts(0, 100), {
  source: 25, optOut: 50, blue: 0, blueOptOut: 0, signature: 25, blueSignature: 0,
});
eq("all microsoft leads", splitCounts(100, 0), {
  source: 0, optOut: 0, blue: 25, blueOptOut: 50, signature: 0, blueSignature: 25,
});
eq("empty campaign", splitCounts(0, 0), {
  source: 0, optOut: 0, blue: 0, blueOptOut: 0, signature: 0, blueSignature: 0,
});
eq("single lead stays put", splitCounts(0, 1), {
  source: 1, optOut: 0, blue: 0, blueOptOut: 0, signature: 0, blueSignature: 0,
});
// Odd counts favour Opt Out's siblings first, then the original over Signature.
eq("odd others favour the source over signature", splitCounts(0, 7),
  { source: 2, optOut: 3, blue: 0, blueOptOut: 0, signature: 2, blueSignature: 0 });
eq("odd microsoft favours the blue original", splitCounts(7, 0),
  { source: 0, optOut: 0, blue: 2, blueOptOut: 3, signature: 0, blueSignature: 2 });
eq("two leads leave signature empty rather than the source",
  splitCounts(0, 2).source >= splitCounts(0, 2).signature, true);
eq("three leads", splitCounts(0, 3),
  { source: 1, optOut: 1, blue: 0, blueOptOut: 0, signature: 1, blueSignature: 0 });
// Conservation: nothing may be invented or lost, at any size.
for (const [ms, other] of [[0,0],[1,0],[0,1],[2,2],[7,13],[9999,1],[10000,10000],[3,4],[12345,54321]]) {
  const c = splitCounts(ms, other);
  eq(`conserves ${ms}+${other}`, sum(c, [...MS_ROLES, ...OTHER_ROLES]), ms + other);
  eq(`microsoft only to blue campaigns (${ms}+${other})`, sum(c, MS_ROLES), ms);
  eq(`others only to non-blue campaigns (${ms}+${other})`, sum(c, OTHER_ROLES), other);
  eq(`no negative counts (${ms}+${other})`,
    Object.values(c).every((n) => n >= 0 && Number.isInteger(n)), true);
  // Opt Out is the deliberate big half, so nothing may quietly exceed it.
  eq(`opt out is the largest non-blue share (${ms}+${other})`,
    c.optOut >= c.source - 1 && c.optOut >= c.signature - 1, true);
}

// planSplit assigns disjoint, complete lead sets
const ms = Array.from({ length: 7 }, (_, i) => `m${i}`);
const ot = Array.from({ length: 5 }, (_, i) => `o${i}`);
const plan = planSplit(ms, ot);
const moved = plan.moves.flatMap((m) => m.leads);
eq("moved leads are unique", new Set(moved).size, moved.length);
eq("moved count matches plan", moved.length,
  plan.counts.blue + plan.counts.blueOptOut + plan.counts.blueSignature +
  plan.counts.optOut + plan.counts.signature);
eq("leads left in source", ot.filter((o) => !moved.includes(o)).length, plan.counts.source);
eq("no microsoft lead stays in source", ms.every((m) => moved.includes(m)), true);
eq("every destination is moved to, and source is not",
  plan.moves.map((m) => m.destination).sort(),
  ["blue", "blueOptOut", "blueSignature", "optOut", "signature"]);
// A microsoft lead landing in a non-blue campaign would send from the wrong
// mailboxes, which is the failure the whole split exists to prevent.
for (const mv of plan.moves) {
  const fromMs = mv.leads.every((l) => l.startsWith("m"));
  const fromOther = mv.leads.every((l) => l.startsWith("o"));
  eq(`${mv.destination} takes one bucket only`,
    MS_ROLES.includes(mv.destination) ? fromMs : fromOther, true);
  eq(`${mv.destination} moves what it planned`, mv.leads.length, plan.counts[mv.destination]);
}

// --- split when some campaigns are missing ----------------------------------
// A Move run takes the campaigns as it finds them: a stage whose campaign is
// not there simply doesn't happen, and its share stays with the rest of its
// provider bucket.
console.log("--- split with campaigns missing");
const avail = (over) => ({
  blue: true, blueOptOut: true, blueSignature: true, optOut: true, signature: true, ...over,
});
eq("with everything there it is the split it always was",
  splitCountsFor(10000, 10000, avail({})), splitCounts(10000, 10000));

// The reported case: both Signature copies missing, the other three there.
eq("no Signature copies: the half that is left stays in its own campaign",
  splitCountsFor(4, 4, avail({ signature: false, blueSignature: false })),
  { source: 2, optOut: 2, blue: 2, blueOptOut: 2, signature: 0, blueSignature: 0 });

// Only the Opt Out pair: it takes half, and the rest has nowhere to halve into.
eq("no blue copy: its share goes to the 🔵 Signature copy",
  splitCountsFor(4, 0, avail({ blue: false })),
  { source: 0, optOut: 0, blue: 0, blueOptOut: 2, signature: 0, blueSignature: 2 });
eq("no Opt Out copies: the bucket is never halved",
  splitCountsFor(4, 4, avail({ optOut: false, blueOptOut: false })),
  { source: 2, optOut: 0, blue: 2, blueOptOut: 0, signature: 2, blueSignature: 2 });

// Microsoft leads must never be sent from non-Microsoft mailboxes, so with no
// 🔵 campaign at all they stay where they are.
// The six Microsoft leads join the one non-Microsoft lead that stays put.
eq("no 🔵 campaign at all: the Microsoft leads stay in the source",
  splitCountsFor(6, 4, avail({ blue: false, blueOptOut: false, blueSignature: false })),
  { source: 7, optOut: 2, blue: 0, blueOptOut: 0, signature: 1, blueSignature: 0 });
eq("…and only the non-Microsoft ones are moved",
  planSplitFor(["m0","m1"], ["o0","o1"], avail({ blue: false, blueOptOut: false, blueSignature: false }))
    .moves.flatMap((m) => m.leads),
  ["o1"]);

// Conservation still holds for every combination of what is there.
const ROLE_KEYS = ["blue", "blueOptOut", "blueSignature", "optOut", "signature"];
for (let bits = 0; bits < 32; bits++) {
  const a = Object.fromEntries(ROLE_KEYS.map((r, i) => [r, !!(bits & (1 << i))]));
  const msN = 13, otN = 11;
  const c = splitCountsFor(msN, otN, a);
  const label = ROLE_KEYS.filter((r) => a[r]).join("+") || "nothing";
  eq(`conserves every lead with ${label}`, sum(c, [...MS_ROLES, ...OTHER_ROLES]), msN + otN);
  eq(`no lead goes to a campaign that isn't there (${label})`,
    ROLE_KEYS.every((r) => a[r] || c[r] === 0), true);
  eq(`non-Microsoft leads never reach a 🔵 campaign (${label})`, sum(c, MS_ROLES) <= msN, true);
  const p = planSplitFor(
    Array.from({ length: msN }, (_, i) => `m${i}`),
    Array.from({ length: otN }, (_, i) => `o${i}`),
    a
  );
  const movedAll = p.moves.flatMap((mv) => mv.leads);
  eq(`the plan moves each lead once (${label})`, new Set(movedAll).size, movedAll.length);
  eq(`…and only into 🔵 campaigns from the Microsoft bucket (${label})`,
    p.moves.every((mv) =>
      mv.leads.every((l) => (MS_ROLES.includes(mv.destination) ? l[0] === "m" : l[0] === "o"))
    ), true);
  eq(`…matching the counts (${label})`,
    p.moves.every((mv) => mv.leads.length === c[mv.destination]), true);
}

// --- esp -------------------------------------------------------------------
const MICROSOFT_MX = ["outlook.com","office365.com","microsoft.com","hotmail.com","messaging.microsoft.com"];
const GOOGLE_MX = ["google.com","googlemail.com","gmail.com"];
const classifyMx = (ex) => {
  const hosts = ex.map((h) => h.toLowerCase().replace(/\.$/, ""));
  if (hosts.some((h) => MICROSOFT_MX.some((m) => h.endsWith(m)))) return "MICROSOFT";
  if (hosts.some((h) => GOOGLE_MX.some((g) => h.endsWith(g)))) return "GOOGLE";
  return "OTHER";
};

console.log("--- esp");
eq("m365 tenant mx", classifyMx(["acme-com.mail.protection.outlook.com"]), "MICROSOFT");
eq("trailing dot tolerated", classifyMx(["acme-com.mail.protection.outlook.com."]), "MICROSOFT");
eq("uppercase tolerated", classifyMx(["ACME.MAIL.PROTECTION.OUTLOOK.COM"]), "MICROSOFT");
eq("google workspace mx", classifyMx(["aspmx.l.google.com"]), "GOOGLE");
eq("googlemail alt", classifyMx(["alt1.aspmx.l.googlemail.com"]), "GOOGLE");
eq("unknown host", classifyMx(["mx.zoho.eu"]), "OTHER");
// No MX at all must never land in the Microsoft bucket — that bucket decides
// which sending infrastructure a lead gets contacted from.
eq("no mx records is OTHER", classifyMx([]), "OTHER");
eq("microsoft wins a mixed record", classifyMx(["mx.zoho.eu", "x.mail.protection.outlook.com"]), "MICROSOFT");
// A lookalike domain must not match by substring alone.
eq("lookalike suffix does not match", classifyMx(["mx.notoutlook.com.evil.net"]), "OTHER");
eq("outlook.com as a bare host", classifyMx(["outlook.com"]), "MICROSOFT");

// --- append opt-out --------------------------------------------------------
const spintaxSrc = readFileSync("src/lib/campaign-types/opt-out-spintax.ts", "utf8");
const SPINTAX = spintaxSrc.match(/export const OPT_OUT_SPINTAX[^`]*`([\s\S]*?)`;/)[1];
const SPACER = "<div>&nbsp;</div>";
const optOutMod = await importTs("@/lib/campaign-types/append-opt-out");
const hasBlock = optOutMod.hasOptOutBlock;
const appendStepOne = optOutMod.appendOptOutToStepOne;

console.log("--- append opt-out");
const seq = [
  { step: 1, wait_time: 0, variations: [
    { variation: "A", subject: "Hi", body: "<div>one</div>" },
    { variation: "B", subject: "Hi", body: "<div>two</div>" },
  ]},
  { step: 2, wait_time: 3, variations: [
    { variation: "A", subject: "Bump", body: "<div>follow up</div>" },
  ]},
];
const r1 = appendStepOne(seq);
eq("both step-1 variations changed", r1.changed, ["A", "B"]);
eq("step 1 variation A got the block", hasBlock(r1.steps[0].variations[0].body), true);
eq("step 1 variation B got the block", hasBlock(r1.steps[0].variations[1].body), true);
eq("step 2 untouched", r1.steps[1].variations[0].body, "<div>follow up</div>");
eq("original body preserved as a prefix", r1.steps[0].variations[0].body.startsWith("<div>one</div>"), true);
eq("spacer sits between body and block", r1.steps[0].variations[0].body.includes(`</div>${SPACER}<div>{{Random`), true);
eq("subject untouched", r1.steps[0].variations[0].subject, "Hi");
eq("every step is returned for the replace-all write", r1.steps.length, seq.length);

// Idempotence — the run may be resumed, and a doubled opt-out line would ship.
const r2 = appendStepOne(r1.steps);
eq("second pass changes nothing", r2.changed, []);
eq("second pass reports both as present", r2.alreadyPresent, ["A", "B"]);
eq("body identical after second pass", r2.steps[0].variations[0].body, r1.steps[0].variations[0].body);
eq("block appears exactly once", r2.steps[0].variations[0].body.split(SPINTAX).length - 1, 1);

// Edge cases
eq("empty body still gets the block", hasBlock(appendStepOne(
  [{ step: 1, variations: [{ variation: "A", body: "" }] }]).steps[0].variations[0].body), true);
eq("missing body field is tolerated", hasBlock(appendStepOne(
  [{ step: 1, variations: [{ variation: "A" }] }]).steps[0].variations[0].body), true);
eq("campaign with no step 1 is a no-op", appendStepOne(
  [{ step: 2, variations: [{ variation: "A", body: "x" }] }]).changed, []);


// --- sign-off swap ----------------------------------------------------------
const {
  swapSignatureInStepOne,
  swapInText,
  hasSenderFirstName,
  hasSenderSignature,
} = await importTs("@/lib/campaign-types/swap-signature");

console.log("--- sign-off swap");
// The tail of the user's real script: the sign-off sits after a spintax block.
const SIGN_OFF = "<div>{{Random | Thanks, | Best, | Take care,}}</div><div>{{sender_first_name}}</div>";
const sigSeq = [
  { step: 1, wait_time: 0, variations: [
    { variation: "A", subject: "Hi {{first_name}}", body: `<div>hello</div>${SIGN_OFF}` },
    { variation: "B", subject: "Hi", body: `<div>other</div>${SIGN_OFF}` },
  ]},
  { step: 2, wait_time: 3, variations: [
    { variation: "A", subject: "Bump", body: `<div>follow up</div>${SIGN_OFF}` },
  ]},
];
const s1 = swapSignatureInStepOne(sigSeq);
eq("both step-1 variations swapped", s1.changed, ["A", "B"]);
eq("the sign-off now uses the signature",
  s1.steps[0].variations[0].body.includes("<div>{{sender_signature}}</div>"), true);
eq("…and no longer the first name",
  hasSenderFirstName(s1.steps[0].variations[0].body), false);
// Step 2 keeping {{sender_first_name}} is the whole point of "step 1 only".
eq("step 2 is left alone", s1.steps[1].variations[0].body, `<div>follow up</div>${SIGN_OFF}`);
eq("the rest of the body is untouched",
  s1.steps[0].variations[0].body.startsWith("<div>hello</div>"), true);
eq("the greeting variable is not touched",
  s1.steps[0].variations[0].subject, "Hi {{first_name}}");
eq("every step is returned for the replace-all write", s1.steps.length, sigSeq.length);
eq("nothing was reported as missing", s1.missing, []);

// Idempotence — a resumed run must not double-swap or report a false problem.
const s2 = swapSignatureInStepOne(s1.steps);
eq("second pass changes nothing", s2.changed, []);
eq("second pass reports both as already signed", s2.alreadyPresent, ["A", "B"]);
eq("…and none as missing", s2.missing, []);
eq("body identical after second pass",
  s2.steps[0].variations[0].body, s1.steps[0].variations[0].body);

// A variation that signs off some other way: reported, never invented.
const odd = swapSignatureInStepOne([
  { step: 1, variations: [
    { variation: "A", body: "<div>hi</div><div>{{sender_first_name}}</div>" },
    { variation: "B", body: "<div>hi</div><div>The team</div>" },
  ]},
]);
eq("the variation with no sign-off variable is reported", odd.missing, ["B"]);
eq("…and is left exactly as it was",
  odd.steps[0].variations[1].body, "<div>hi</div><div>The team</div>");
eq("…while its sibling is still swapped", odd.changed, ["A"]);

// A subject signed with the first name would contradict the body.
const subj = swapSignatureInStepOne([
  { step: 1, variations: [{ variation: "A", subject: "from {{sender_first_name}}", body: "<div>hi</div>" }] },
]);
eq("the subject is swapped too", subj.steps[0].variations[0].subject, "from {{sender_signature}}");

eq("padded braces are matched", swapInText("{{ sender_first_name }}"), "{{sender_signature}}");
eq("every occurrence is swapped",
  swapInText("{{sender_first_name}} x {{sender_first_name}}"),
  "{{sender_signature}} x {{sender_signature}}");
eq("a lookalike variable is left alone",
  swapInText("{{sender_first_name_2}}"), "{{sender_first_name_2}}");
eq("an empty body is not a crash", swapInText(""), "");
eq("detection agrees with the swap",
  [hasSenderFirstName("a {{sender_first_name}} b"), hasSenderSignature("a {{sender_signature}} b")],
  [true, true]);

// --- companion matching -----------------------------------------------------
// The REAL module, so a change to the matching that breaks these is caught.
const matchMod = await importTs("@/lib/campaign-types/match");
const { matchCompanions, matchMoveTargets, normalizeName, looseKey, isArchived } =
  matchMod;

console.log("--- companion matching");
const SRC = { id: "s1", name: "Tree Removal (August)" };
const full = [
  SRC,
  { id: "b1", name: "\u{1F535} Tree Removal (August)" },
  { id: "o1", name: "Tree Removal - Opt Out (August)" },
  { id: "bo1", name: "\u{1F535} Tree Removal - Opt Out (August)" },
];
const r = matchCompanions(SRC.name, full, SRC.id);
eq("all three companions found", r.complete, true);
eq("blue maps to the blue campaign", r.matches[0].match.id, "b1");
eq("optOut maps to the opt out campaign", r.matches[1].match.id, "o1");
eq("blueOptOut maps to the blue opt out campaign", r.matches[2].match.id, "bo1");
eq("exact matches are not flagged loose", r.matches.every((m) => !m.loose), true);

// The screenshot's real list, where the blue copy carries a stray dash.
const strayDash = matchCompanions(SRC.name, [
  { id: "b1", name: "\u{1F535} Tree Removal - (August)" },
  { id: "o1", name: "Tree Removal - Opt Out (August)" },
  { id: "bo1", name: "\u{1F535} Tree Removal - Opt Out (August)" },
], SRC.id);
eq("a stray dash before the parenthetical still matches", strayDash.complete, true);
eq("stray-dash blue maps correctly", strayDash.matches[0].match.id, "b1");
eq("the loose match is flagged for a second look", strayDash.matches[0].loose, true);
eq("the exact matches beside it are not flagged", strayDash.matches[1].loose, false);

// The source must never be matched into a role - it would move leads to itself.
const selfy = matchCompanions(SRC.name, [SRC], SRC.id);
eq("source is excluded from the pool", selfy.matches.every((m) => m.match === null), true);
eq("incomplete when companions are missing", selfy.complete, false);

// Human duplication is sloppy: case, doubled spaces, missing variation selector.
const sloppy = matchCompanions(SRC.name, [
  { id: "b1", name: "\u{1F535}\uFE0F  tree removal  (August) " },
  { id: "o1", name: "TREE REMOVAL - OPT OUT (AUGUST)" },
  { id: "bo1", name: "\u{1F535} Tree Removal - Opt Out (August)" },
], SRC.id);
eq("tolerates case, spacing and the emoji variation selector", sloppy.complete, true);

// Sub-sequences are separate campaign records and are never a role.
const withSub = matchCompanions(SRC.name, [
  { id: "sub", name: "\u{1F535} Tree Removal (August)", campaignType: "subseq" },
  { id: "b1", name: "\u{1F535} Tree Removal (August)" },
], SRC.id);
eq("sub-sequences are excluded", withSub.matches[0].match.id, "b1");

// Two campaigns with the same name: refuse rather than guess.
const dupes = matchCompanions(SRC.name, [
  { id: "b1", name: "\u{1F535} Tree Removal (August)" },
  { id: "b2", name: "\u{1F535} Tree Removal (August)" },
], SRC.id);
eq("duplicate names are ambiguous, not guessed", dupes.matches[0].ambiguous, true);
eq("ambiguous role is left unmatched", dupes.matches[0].match, null);

// --- Move Leads: finding all five campaigns ---------------------------------
// A move run creates nothing, so every one of the five has to be there already.
console.log("--- move targets");
const FIVE = [
  SRC,
  { id: "b1", name: "\u{1F535} Consulting (August)", status: "ACTIVE" },
  { id: "o1", name: "Consulting - Opt Out (August)", status: "PAUSED" },
  { id: "bo1", name: "\u{1F535} Consulting - Opt Out (August)", status: "COMPLETED" },
  { id: "s1x", name: "Consulting - Signature (August)", status: "ACTIVE" },
  { id: "bs1", name: "\u{1F535} Consulting - Signature (August)", status: "ACTIVE" },
];
const CONSULTING = { id: "c0", name: "Consulting (August)" };
const five = matchMoveTargets(CONSULTING.name, FIVE, CONSULTING.id);
eq("all five are found", five.complete, true);
eq("…in role order", five.matches.map((m) => [m.role, m.match?.id]), [
  ["blue", "b1"],
  ["optOut", "o1"],
  ["blueOptOut", "bo1"],
  ["signature", "s1x"],
  ["blueSignature", "bs1"],
]);
eq("…whatever their status, as long as it isn't archived",
  five.matches.every((m) => m.match), true);

// Archived campaigns can't take a lead, so their names don't count as found.
const archived = matchMoveTargets(CONSULTING.name, [
  { id: "b1", name: "\u{1F535} Consulting (August)", status: "ARCHIVED" },
  { id: "o1", name: "Consulting - Opt Out (August)", status: "ACTIVE" },
], CONSULTING.id);
eq("an archived campaign is not a match", archived.matches[0].match, null);
eq("…while the live one beside it still is", archived.matches[1].match.id, "o1");
eq("…so the run is incomplete", archived.complete, false);

// A live campaign wins over an archived one holding the same name.
const both = matchMoveTargets(CONSULTING.name, [
  { id: "old", name: "\u{1F535} Consulting (August)", status: "ARCHIVED" },
  { id: "new", name: "\u{1F535} Consulting (August)", status: "ACTIVE" },
], CONSULTING.id);
eq("the live campaign is taken, not the archived namesake", both.matches[0].match.id, "new");
eq("…and that is not ambiguous", both.matches[0].ambiguous, false);

const missing = matchMoveTargets(CONSULTING.name, [
  { id: "b1", name: "\u{1F535} Consulting (August)" },
], CONSULTING.id);
eq("a missing companion is reported, not guessed at",
  missing.matches.filter((m) => !m.match).map((m) => m.expectedName),
  [
    "Consulting - Opt Out (August)",
    "\u{1F535} Consulting - Opt Out (August)",
    "Consulting - Signature (August)",
    "\u{1F535} Consulting - Signature (August)",
  ]);
eq("…and the whole thing is incomplete", missing.complete, false);
eq("the three-role call still only asks for three",
  matchCompanions(CONSULTING.name, FIVE, CONSULTING.id).matches.map((m) => m.role),
  ["blue", "optOut", "blueOptOut"]);

// Loose matching must not resolve a genuine ambiguity either.
const looseDupes = matchCompanions(SRC.name, [
  { id: "b1", name: "\u{1F535} Tree Removal - (August)" },
  { id: "b2", name: "\u{1F535} Tree Removal -- (August)" },
], SRC.id);
eq("two loose candidates are ambiguous", looseDupes.matches[0].ambiguous, true);

// A near-miss must not be matched to the wrong campaign.
const nearMiss = matchCompanions(SRC.name, [
  { id: "x", name: "\u{1F535} Tree Removal (September)" },
  { id: "y", name: "Tree Removal - Opt Out (September)" },
], SRC.id);
eq("a different month does not match", nearMiss.matches.every((m) => m.match === null), true);
// Loosening punctuation must never loosen identity.
eq("loose matching does not cross months",
  looseKey("\u{1F535} Tree Removal (August)") === looseKey("\u{1F535} Tree Removal (September)"), false);
eq("loose matching does not merge opt out with the plain copy",
  looseKey("Tree Removal (August)") === looseKey("Tree Removal - Opt Out (August)"), false);


// --- duplication reuse guard ------------------------------------------------
// Duplication is NOT idempotent: /campaign/duplicate always creates a new
// campaign. A resumed run must adopt the copies it already made instead of
// creating a second set under the same names.
console.log("--- duplication reuse guard");
const planDuplication = (sourceName, existingCampaigns) => {
  const names = deriveNames(sourceName);
  const existing = new Map();
  for (const c of existingCampaigns) {
    if (c.campaignType === "subseq") continue;
    const k = normalizeName(c.name);
    if (!existing.has(k)) existing.set(k, c.id);
  }
  return ["blue", "optOut", "blueOptOut"].map((role) => {
    const name = names[role];
    const found = existing.get(normalizeName(name));
    return { role, name, action: found ? "reuse" : "create", id: found ?? null };
  });
};

const SRC2 = "Tree Removal (August)";
eq("a fresh workspace creates all three",
  planDuplication(SRC2, []).map((p) => p.action), ["create", "create", "create"]);

// The resumed-run case: blue was made before the interruption.
const partial = planDuplication(SRC2, [
  { id: "b1", name: "\u{1F535} Tree Removal (August)" },
]);
eq("an existing copy is reused, not duplicated again",
  partial.map((p) => p.action), ["reuse", "create", "create"]);
eq("the reused copy keeps its id", partial[0].id, "b1");

// Everything already there: a full re-run creates nothing.
const allThere = planDuplication(SRC2, [
  { id: "b1", name: "\u{1F535} Tree Removal (August)" },
  { id: "o1", name: "Tree Removal - Opt Out (August)" },
  { id: "bo1", name: "\u{1F535} Tree Removal - Opt Out (August)" },
]);
eq("a full re-run duplicates nothing",
  allThere.map((p) => p.action), ["reuse", "reuse", "reuse"]);
eq("ids all resolve", allThere.map((p) => p.id), ["b1", "o1", "bo1"]);

// A sub-sequence sharing the name must not be adopted as a parent campaign.
eq("a sub-sequence is never reused",
  planDuplication(SRC2, [
    { id: "sub", name: "\u{1F535} Tree Removal (August)", campaignType: "subseq" },
  ])[0].action, "create");

// The source itself must never be adopted for a role.
eq("the source name does not collide with any derived name",
  planDuplication(SRC2, [{ id: "s1", name: SRC2 }]).every((p) => p.action === "create"), true);

// The five derived names must be distinct, or two roles would adopt the same
// campaign and the split would move two buckets into one place.
const derived = deriveNames(SRC2);
eq("derived names are distinct after normalization",
  new Set(Object.values(derived).map(normalizeName)).size, 5);
eq("no derived name equals the source",
  Object.values(derived).some((n) => normalizeName(n) === normalizeName(SRC2)), false);

// Duplication order, from the REAL constants the job runs on: blue must exist
// before the two 🔵 copies duplicate from it.
const roles = await importTs("@/lib/jobs/campaign-types-types");
eq("every created role has a name and a job to do",
  roles.CREATED_ROLES.slice().sort(),
  ["blue", "blueOptOut", "blueSignature", "optOut", "signature"]);
eq("the 🔵 copies duplicate from blue",
  roles.FROM_BLUE_ROLES.slice().sort(), ["blueOptOut", "blueSignature"]);
for (const r of roles.FROM_BLUE_ROLES) {
  eq(`blue is created before ${r}`,
    roles.CREATED_ROLES.indexOf("blue") < roles.CREATED_ROLES.indexOf(r), true);
}
eq("blue itself is not copied from blue", roles.FROM_BLUE_ROLES.includes("blue"), false);
// A role in both lists would have its step 1 rewritten twice, and the second
// pass would be writing over copy the first one had just put there.
eq("no role is both an Opt Out and a Signature copy",
  roles.OPT_OUT_ROLES.some((r) => roles.SIGNATURE_ROLES.includes(r)), false);
eq("every Opt Out and Signature role is one the tool creates",
  [...roles.OPT_OUT_ROLES, ...roles.SIGNATURE_ROLES].every((r) =>
    roles.CREATED_ROLES.includes(r)), true);
// Each created role must be able to find its name in the payload.
eq("every created role is named by deriveNames",
  roles.CREATED_ROLES.every((r) => typeof deriveNames(SRC2)[r] === "string"), true);

// --- the yellow circle ------------------------------------------------------
// Google campaigns are now named "🟡 X (Month)". The plain copies keep the
// circle, the 🔵 copies replace it, and a source without one is named
// exactly as before.
console.log("--- yellow circle");
const YELLOW = "\u{1F7E1}";
const { withYellow, hasYellow, stripYellow } = namesMod;
eq("the user's example", deriveNames(`${YELLOW} Home Services Broad V2 (August)`), {
  blue: `${BLUE} Home Services Broad V2 (August)`,
  optOut: `${YELLOW} Home Services Broad V2 - Opt Out (August)`,
  blueOptOut: `${BLUE} Home Services Broad V2 - Opt Out (August)`,
  signature: `${YELLOW} Home Services Broad V2 - Signature (August)`,
  blueSignature: `${BLUE} Home Services Broad V2 - Signature (August)`,
});
eq("the 🔵 copies never carry both circles",
  Object.values(deriveNames(`${YELLOW} Tree Removal (August)`)).some((n) => n.includes(YELLOW) && n.includes(BLUE)), false);
eq("a source without the circle is named as it always was",
  deriveNames("Tree Removal (August)"), {
    blue: `${BLUE} Tree Removal (August)`,
    optOut: "Tree Removal - Opt Out (August)",
    blueOptOut: `${BLUE} Tree Removal - Opt Out (August)`,
    signature: "Tree Removal - Signature (August)",
    blueSignature: `${BLUE} Tree Removal - Signature (August)`,
  });
eq("the variation selector and a missing space are tolerated",
  [hasYellow(`${YELLOW}️Tree Removal`), stripYellow(`${YELLOW}️  Tree Removal (August)`)],
  [true, "Tree Removal (August)"]);
eq("yellow is not doubled", withYellow(`${YELLOW} Tree Removal`), `${YELLOW} Tree Removal`);
eq("all five names still differ from each other and the source", (() => {
  const src = `${YELLOW} Tree Removal (August)`;
  const all = Object.values(deriveNames(src));
  return [new Set(all).size, all.includes(src)];
})(), [5, false]);

// The companions of a 🟡 source are found by the same derived names, so a
// Move Leads run on one lands in the right campaigns.
{
  const src = `${YELLOW} Tree Removal (August)`;
  const pool = [
    { id: "s", name: src },
    { id: "b", name: `${BLUE} Tree Removal (August)` },
    { id: "o", name: `${YELLOW} Tree Removal - Opt Out (August)` },
    { id: "bo", name: `${BLUE} Tree Removal - Opt Out (August)` },
    { id: "g", name: `${YELLOW} Tree Removal - Signature (August)` },
    { id: "bg", name: `${BLUE} Tree Removal - Signature (August)` },
    { id: "old", name: "Tree Removal - Opt Out (August)" }, // the pre-circle naming: not this source's
  ];
  const r = matchMod.matchMoveTargets(src, pool, "s");
  eq("a 🟡 source finds its five 🟡/🔵 companions", r.matches.map((m) => m.match?.id), ["b", "o", "bo", "g", "bg"]);
  eq("…and never the un-circled campaign of the same name", r.matches.some((m) => m.match?.id === "old"), false);
}

// --- dominant targeting ------------------------------------------------------
console.log("--- dominant targeting");
const settingsMod = await importTs("@/lib/campaign-types/settings");
const { sidesFor, parseLimit, normalizeSettings, limitForRole, DEFAULT_SETTINGS, describeLimits } = settingsMod;
const classified = [
  { lead: "m1", esp: "MICROSOFT" },
  { lead: "g1", esp: "GOOGLE" },
  { lead: "o1", esp: "OTHER" },
  { lead: "m2", esp: "MICROSOFT" },
  { lead: "o2", esp: "OTHER" },
  { lead: "g2", esp: "GOOGLE" },
];
eq("Google dominant: the other leads stay with the Google ones, in order",
  sidesFor(classified, "google"), { blue: ["m1", "m2"], plain: ["g1", "o1", "o2", "g2"] });
eq("Microsoft dominant: the other leads go to the 🔵 side, in order",
  sidesFor(classified, "microsoft"), { blue: ["m1", "o1", "m2", "o2"], plain: ["g1", "g2"] });
eq("either way every lead lands exactly once",
  ["google", "microsoft"].map((d) => { const s = sidesFor(classified, d); return s.blue.length + s.plain.length; }), [6, 6]);
eq("Google dominant is the two-way split the tool always made",
  sidesFor(classified, "google").blue, classified.filter((c) => c.esp === "MICROSOFT").map((c) => c.lead));
eq("no leads, no sides", sidesFor([], "microsoft"), { blue: [], plain: [] });

// --- the settings ------------------------------------------------------------
console.log("--- settings");
eq("the defaults are what the tool did before: Google dominant, limits as duplicated",
  [DEFAULT_SETTINGS.dominant, DEFAULT_SETTINGS.googleDailyLimit, DEFAULT_SETTINGS.microsoftDailyLimit], ["google", null, null]);
eq("a limit is a whole number from 0 up", [parseLimit(3000, "x").value, parseLimit("1500", "x").value, parseLimit(0, "x").value], [3000, 1500, 0]);
eq("blank means not set", [parseLimit("", "x"), parseLimit(null, "x"), parseLimit(undefined, "x")], [{ value: null }, { value: null }, { value: null }]);
eq("a fraction is refused", parseLimit(12.5, "Google daily limit").error, "Google daily limit: use a whole number.");
eq("a negative is refused", parseLimit(-1, "Google daily limit").error, "Google daily limit: can't be negative.");
eq("nonsense is refused", parseLimit("lots", "Microsoft daily limit").error, "Microsoft daily limit: enter a number, or leave it blank.");
eq("a stored file with junk in it reads as the defaults",
  normalizeSettings({ dominant: "yahoo", googleDailyLimit: "x", microsoftDailyLimit: -5 }),
  { dominant: "google", googleDailyLimit: null, microsoftDailyLimit: null, updatedAt: 0 });
eq("…and a good one reads as itself",
  normalizeSettings({ dominant: "microsoft", googleDailyLimit: 3000, microsoftDailyLimit: 1500, updatedAt: 7 }),
  { dominant: "microsoft", googleDailyLimit: 3000, microsoftDailyLimit: 1500, updatedAt: 7 });
const S = { dominant: "microsoft", googleDailyLimit: 3000, microsoftDailyLimit: 1500 };
eq("the plain copies get the Google limit", ["optOut", "signature"].map((r) => limitForRole(r, S)), [3000, 3000]);
eq("the 🔵 copies get the Microsoft limit", ["blue", "blueOptOut", "blueSignature"].map((r) => limitForRole(r, S)), [1500, 1500, 1500]);
eq("a blank limit sets nothing on that side", limitForRole("blue", { ...S, microsoftDailyLimit: null }), null);
eq("the limits read as a sentence", [describeLimits(S), describeLimits({ ...S, googleDailyLimit: null, microsoftDailyLimit: null })],
  ["Google copies 3,000/day · 🔵 copies 1,500/day", "daily limits as duplicated"]);

console.log(failures === 0 ? "\nall campaign-types checks OK" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
