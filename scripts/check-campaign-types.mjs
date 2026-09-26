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

// A campaign made before the text changed carries the previous block. It is
// swapped for the current one in place — never a second opt-out line under it.
{
  const prevSrc = readFileSync("src/lib/campaign-types/opt-out-spintax-previous.ts", "utf8");
  const PREV = prevSrc.match(/export const PREVIOUS_OPT_OUT_SPINTAX[^`]*`([\s\S]*?)`;/)[1];
  const oldBody = `<div>hello</div>${SPACER}<div>${PREV}</div>`;
  const r = appendStepOne([{ step: 1, variations: [{ variation: "A", body: oldBody }, { variation: "B", body: "<div>fresh</div>" }] }]);
  const a = r.steps[0].variations[0].body;
  eq("the previous block is recognised and swapped", [r.changed, r.replaced, r.alreadyPresent], [["A", "B"], ["A"], []]);
  eq("…leaving the current block exactly once, and none of the old", [a.split(SPINTAX).length - 1, a.includes(PREV)], [1, false]);
  eq("…in the same place, the rest of the body untouched", a, `<div>hello</div>${SPACER}<div>${SPINTAX}</div>`);
  eq("a body with neither still just gets it appended", r.steps[0].variations[1].body, `<div>fresh</div>${SPACER}<div>${SPINTAX}</div>`);
  const again = appendStepOne(r.steps);
  eq("…and a second pass changes nothing", [again.changed, again.alreadyPresent], [[], ["A", "B"]]);
}

// The same blocks as Plusvibe's editor hands them back: quotes as entities or
// curly, apostrophes as &#39;, spaces as &nbsp;, a <br> or two. Missing these
// is what left a second block stacked under the old one.
{
  const prevSrc = readFileSync("src/lib/campaign-types/opt-out-spintax-previous.ts", "utf8");
  const PREV = prevSrc.match(/export const PREVIOUS_OPT_OUT_SPINTAX[^`]*`([\s\S]*?)`;/)[1];
  const edited = (t) => t.replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/ \| /g, "&nbsp;| ");
  const curly = (t) => t.replace(/"([^"]*)"/g, "\u201C$1\u201D").replace(/'/g, "\u2019").replace(/ \| If/g, " |<br>If");
  const GREET = "<div>{{Random | Hey {{first_name}}, | Hi {{first_name}},}}</div>";
  const SIGN = "<div>{{Random | Thanks, | Best, | Regards,}}</div><div>{{sender_first_name}}</div>";
  const count = (b, t) => b.split(t).length - 1;

  const enc = appendStepOne([{ step: 1, variations: [{ variation: "A", body: `${GREET}<div>hello</div>${SIGN}${SPACER}<div>${edited(PREV)}</div>` }] }]);
  const a = enc.steps[0].variations[0].body;
  eq("an old block spelled with entities is recognised and swapped", [enc.replaced, count(a, SPINTAX), a.includes("&quot;")], [["A"], 1, false]);
  eq("…the greeting and sign-off spintax untouched", a.startsWith(`${GREET}<div>hello</div>${SIGN}`), true);

  const cur = appendStepOne([{ step: 1, variations: [{ variation: "A", body: `<div>x</div>${SPACER}<div>${curly(PREV)}</div>` }] }]);
  eq("…so is one with curly quotes and line breaks", [cur.replaced, count(cur.steps[0].variations[0].body, SPINTAX)], [["A"], 1]);

  // What the bug left behind: the old block, and the current one added under it.
  const both = `<div>hello</div>${SIGN}${SPACER}<div>${edited(PREV)}</div>${SPACER}<div>${SPINTAX}</div>`;
  const fixed = appendStepOne([{ step: 1, variations: [{ variation: "A", body: both }] }]).steps[0].variations[0].body;
  eq("a variant with both blocks ends with one, the current, where the old one was", fixed, `<div>hello</div>${SIGN}${SPACER}<div>${SPINTAX}</div>`);

  // The current block as it read before its last line lost the 👋.
  const withWave = SPINTAX.replace(`Reply "wave" and I'll leave with a smile.`, `Reply "wave" or 👋 and I'll leave with a smile.`);
  eq("(the earlier wording differs from the current)", withWave !== SPINTAX, true);
  const waved = appendStepOne([{ step: 1, variations: [{ variation: "A", body: `<div>x</div>${SPACER}<div>${withWave}</div>` }] }]);
  eq("the earlier wording of the current block is replaced too — no emoji left", [waved.replaced, waved.steps[0].variations[0].body.includes("👋")], [["A"], false]);

  const same = appendStepOne([{ step: 1, variations: [{ variation: "A", body: `<div>x</div>${SPACER}<div>${edited(SPINTAX)}</div>` }] }]);
  eq("the current block, however it is spelled, is left alone", [same.changed, same.alreadyPresent], [[], ["A"]]);

  const plain = appendStepOne([{ step: 1, variations: [{ variation: "A", body: `${GREET}<div>hello</div>${SIGN}` }] }]);
  eq("greeting and sign-off spintax are not taken for opt-out lines: the block is appended", [plain.changed, plain.replaced, count(plain.steps[0].variations[0].body, SPINTAX)], [["A"], [], 1]);
}


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

// --- the two pools ------------------------------------------------------------
// Google recipients stay on the plain side; Microsoft and everyone whose
// provider is neither go to the 🔵 campaigns. Every campaign is in one pool.
console.log("--- pools");
const poolsMod = await importTs("@/lib/campaign-types/pools");
const { sidesFor, poolOf, POOL_TAGS, isBlueRole } = poolsMod;
const classified = [
  { lead: "m1", esp: "MICROSOFT" },
  { lead: "g1", esp: "GOOGLE" },
  { lead: "o1", esp: "OTHER" },
  { lead: "m2", esp: "MICROSOFT" },
  { lead: "o2", esp: "OTHER" },
  { lead: "g2", esp: "GOOGLE" },
];
eq("Microsoft and other-ESP leads go to the 🔵 side, in order; Google stays plain",
  sidesFor(classified), { blue: ["m1", "o1", "m2", "o2"], plain: ["g1", "g2"] });
eq("every lead lands exactly once", (() => { const s = sidesFor(classified); return s.blue.length + s.plain.length; })(), 6);
eq("no leads, no sides", sidesFor([]), { blue: [], plain: [] });
eq("the source and the plain copies are Google campaigns", ["source", "optOut", "signature"].map(poolOf), ["google", "google", "google"]);
eq("the 🔵 copies are Microsoft ones", ["blue", "blueOptOut", "blueSignature"].map(poolOf), ["microsoft", "microsoft", "microsoft"]);
eq("…which is what isBlueRole says", roles.CREATED_ROLES.map((r) => isBlueRole(r)), [true, false, true, false, true]);
eq("the pool tags are named as asked", [POOL_TAGS.google.name, POOL_TAGS.microsoft.name], ["google-pool", "microsoft-pool"]);
eq("…each with a colour the API will take", [POOL_TAGS.google.color, POOL_TAGS.microsoft.color].every((c) => /^#[0-9A-F]{6}$/i.test(c)), true);

// --- campaign types ------------------------------------------------------------
console.log("--- campaign types");
const kindsMod = await importTs("@/lib/campaign-types/kinds");
const { rolesFor, normalizeKinds, kindOfRole, describeKinds, KIND_ORDER, KIND_LABELS } = kindsMod;
eq("the three types, then Opt Out only, in order", KIND_ORDER, ["default", "optOut", "signature", "optOutOnly"]);
eq("…named as the form shows them", KIND_ORDER.map((k) => KIND_LABELS[k]), ["Default", "With Opt Out", "With Signature", "Opt Out only"]);
eq("all three types make all five copies, in creation order", rolesFor(["default", "optOut", "signature"]), roles.CREATED_ROLES);
eq("Default alone makes the 🔵 copy only", rolesFor(["default"]), ["blue"]);
eq("With Opt Out makes the pair", rolesFor(["optOut"]), ["optOut", "blueOptOut"]);
eq("With Signature makes the pair", rolesFor(["signature"]), ["signature", "blueSignature"]);
eq("no type, no copies", rolesFor([]), []);
eq("the order of the types given does not change the creation order", rolesFor(["signature", "default"]), ["blue", "signature", "blueSignature"]);
eq("whatever the form sends is cleaned: junk out, repeats folded, order fixed",
  normalizeKinds(["signature", "x", "default", "signature", 3, null]), ["default", "signature"]);
eq("not a list is nothing", [normalizeKinds("default"), normalizeKinds(undefined)], [[], []]);
eq("every copy belongs to a type", roles.CREATED_ROLES.map(kindOfRole), ["default", "optOut", "optOut", "signature", "signature"]);
eq("the types read as a list", describeKinds(["signature", "default"]), "Default, With Signature");

console.log("--- Opt Out only");
{
  const { toggleKinds, convertsOriginal, DEFAULT_KINDS } = kindsMod;
  const { deriveNames } = await importTs("@/lib/campaign-types/names");
  eq("Opt Out only makes the 🔵 Opt Out copy alone", rolesFor(["optOutOnly"]), ["blueOptOut"]);
  eq("…and stands alone: sent with the others, it is the one kept", normalizeKinds(["default", "optOutOnly", "signature"]), ["optOutOnly"]);
  eq("…and says the originals are converted", [convertsOriginal(["optOutOnly"]), convertsOriginal(DEFAULT_KINDS)], [true, false]);
  eq("ticking it clears the three", toggleKinds(["default", "optOut", "signature"], "optOutOnly"), ["optOutOnly"]);
  eq("ticking one of the three clears it", toggleKinds(["optOutOnly"], "signature"), ["signature"]);
  eq("unticking it goes back to the three, not to nothing", toggleKinds(["optOutOnly"], "optOutOnly"), ["default", "optOut", "signature"]);
  eq("the three still tick and untick as before", [toggleKinds(["default", "optOut"], "optOut"), toggleKinds(["signature"], "default")], [["default"], ["default", "signature"]]);
  const n = deriveNames("🟡 SaaS - GEO - Sales Led (August)");
  eq("the original takes the Opt Out name, 🟡 kept; its 🔵 copy the 🔵 Opt Out name", [n.optOut, n.blueOptOut], ["🟡 SaaS - GEO - Sales Led - Opt Out (August)", "🔵 SaaS - GEO - Sales Led - Opt Out (August)"]);
  const again = deriveNames("🟡 SaaS - GEO - Sales Led - Opt Out (August)");
  eq("an original already named Opt Out keeps its name, and its 🔵 copy matches", [again.optOut, again.blueOptOut], ["🟡 SaaS - GEO - Sales Led - Opt Out (August)", "🔵 SaaS - GEO - Sales Led - Opt Out (August)"]);
}

// --- sorting by segment ---------------------------------------------------------
console.log("--- segments");
const segMod = await importTs("@/lib/campaign-types/segments");
const { segmentOf, segmentKey, validateRules, normalizeRules, planSegmentMoves, describeRule, describeUnmapped, nearestRule, MAX_RULES } = segMod;
eq("four rows: three segments and the empty one", MAX_RULES, 4);
eq("the segment is read off the lead, trimmed", segmentOf({ email: "a@x.com", segment: "  cash pay " }), "cash pay");
eq("…whatever the key's case", segmentOf({ Segment: "insurance" }), "insurance");
eq("…or where the API puts custom fields", [segmentOf({ custom_variables: { segment: "vip" } }), segmentOf({ payload: { segment: "vip" } })], ["vip", "vip"]);
eq("no segment is the empty string", [segmentOf({ email: "a@x.com" }), segmentOf({ segment: null }), segmentOf({ segment: "   " })], ["", "", ""]);
eq("a number is a segment too", segmentOf({ segment: 2 }), "2");
eq("segments compare without case or edges", [segmentKey(" Cash Pay "), segmentKey("cash pay"), segmentKey(null)], ["cash pay", "cash pay", ""]);

const RULES = [
  { segment: "cash pay", campaignId: "A", campaignName: "🟡 A" },
  { segment: "Insurance", campaignId: "B", campaignName: "🟡 B" },
  { segment: null, campaignId: "C", campaignName: "🟡 C" },
];
eq("good rules have no problems", validateRules(RULES, ["A", "B", "C"]), []);
eq("a rule needs a campaign", validateRules([{ segment: "cash pay", campaignId: "", campaignName: "" }], ["A"]), ["Row 1: pick the campaign its leads go to."]);
eq("…one of the originals picked", validateRules([{ segment: "cash pay", campaignId: "Z", campaignName: "🟡 Z" }], ["A"]),
  ['Row 1: "🟡 Z" is not one of the original campaigns picked.']);
eq("the empty row needs one too", validateRules([{ segment: null, campaignId: "", campaignName: "" }], ["A"]), ["The empty-segment row: pick the campaign its leads go to."]);
eq("a blank segment with a campaign is a half-filled row", validateRules([{ segment: "", campaignId: "A", campaignName: "🟡 A" }], ["A"]),
  ["Row 1: give the segment a name, or leave the row out."]);
eq("the same segment twice is refused, whatever the case",
  validateRules([RULES[0], { segment: "CASH PAY", campaignId: "B", campaignName: "🟡 B" }], ["A", "B"]), ['Row 2: "CASH PAY" is already on another row.']);
eq("two empty rows are refused", validateRules([RULES[2], { segment: null, campaignId: "A", campaignName: "🟡 A" }], ["A", "C"]), ["Only one row can be for leads with no segment."]);
eq("two segments may go to the same campaign", validateRules([RULES[0], { segment: "insurance", campaignId: "A", campaignName: "🟡 A" }], ["A"]), []);
eq("no rules is fine: the phase is skipped", validateRules([], ["A"]), []);

eq("what the form sends is cleaned: empty rows dropped, the rest trimmed",
  normalizeRules([{ segment: " cash pay ", campaignId: " A ", campaignName: "🟡 A" }, { segment: "", campaignId: "" }, { segment: null, campaignId: "C", campaignName: "🟡 C" }, "junk"]),
  [{ segment: "cash pay", campaignId: "A", campaignName: "🟡 A" }, { segment: null, campaignId: "C", campaignName: "🟡 C" }]);
eq("…a half-filled row is kept for validation to name", normalizeRules([{ segment: "", campaignId: "A" }]), [{ segment: "", campaignId: "A", campaignName: "" }]);
eq("…at most four rows", normalizeRules(Array.from({ length: 6 }, (_, i) => ({ segment: `s${i}`, campaignId: "A" }))).length, 4);
eq("not a list is no rules", normalizeRules(undefined), []);

// The plan: leads from every original, each to the campaign its segment names.
const L = (id, segment) => ({ _id: id, email: `${id}@x.com`, ...(segment === undefined ? {} : { segment }) });
const segPlan = planSegmentMoves(
  [
    { campaignId: "A", leads: [L("a1", "cash pay"), L("a2", "Insurance"), L("a3", ""), L("a4", "wholesale"), L("a5", "CASH PAY")] },
    { campaignId: "B", leads: [L("b1", "insurance"), L("b2", "cash pay"), L("b3")] },
    { campaignId: "C", leads: [L("c1", ""), L("c2", "cash pay ")] },
  ],
  RULES
);
eq("every lead is counted once", segPlan.counts.total, 10);
eq("leads already in their segment's campaign stay", segPlan.counts.stayed, 4); // a1, a5, b1, c1
eq("a segment on no row is left alone and named", [segPlan.counts.unmapped, segPlan.counts.unmappedSegments], [1, ["wholesale"]]);
eq("the rest are planned", segPlan.counts.planned, 5);
eq("…per rule, in rule order", segPlan.counts.perRule.map((r) => [r.segment, r.planned]), [["cash pay", 2], ["Insurance", 1], [null, 2]]);
eq("moves are grouped by from → to, in the order met", segPlan.moves.map((m) => [m.fromCampaignId, m.toCampaignId, m.leads.map((l) => l._id)]), [
  ["A", "B", ["a2"]],
  ["A", "C", ["a3"]],
  ["B", "A", ["b2"]],
  ["B", "C", ["b3"]],
  ["C", "A", ["c2"]],
]);
eq("…each move knowing its rule", segPlan.moves.map((m) => [m.segment, m.toCampaignName]), [["Insurance", "🟡 B"], [null, "🟡 C"], ["cash pay", "🟡 A"], [null, "🟡 C"], ["cash pay", "🟡 A"]]);
eq("a lead never moves into the campaign it is in", segPlan.moves.every((m) => m.fromCampaignId !== m.toCampaignId), true);
eq("with no empty row, leads with no segment stay put",
  planSegmentMoves([{ campaignId: "A", leads: [L("a3", ""), L("b3")] }], RULES.slice(0, 2)).counts, { total: 2, stayed: 0, unmapped: 2, unmappedSegments: [], planned: 0, perRule: [{ segment: "cash pay", campaignId: "A", planned: 0 }, { segment: "Insurance", campaignId: "B", planned: 0 }] });
eq("no rules, nothing moves", planSegmentMoves([{ campaignId: "A", leads: [L("a1", "cash pay")] }], []).moves, []);
eq("a rule without a campaign is ignored rather than moving leads nowhere",
  planSegmentMoves([{ campaignId: "A", leads: [L("a1", "x")] }], [{ segment: "x", campaignId: "", campaignName: "" }]).counts.unmapped, 1);
eq("a rule reads as a sentence", [describeRule(RULES[0]), describeRule(RULES[2])], ["cash pay → 🟡 A", "no segment → 🟡 C"]);

// --- saying why leads were left behind ------------------------------------------------
// Matching is exact bar case and space, so a row off by one letter covers
// nothing at all — and the two strings are never otherwise seen side by side.
console.log("--- the uncovered-segment message");
const ROWS = [
  { segment: "apps", campaignId: "A", campaignName: "🟡 Apps (August)" },
  { segment: "ecommerce", campaignId: "B", campaignName: "🟡 eCommerce (August)" },
];
eq("a row that is nearly the segment is spotted", nearestRule("app", ROWS), "apps");
eq("…the other way round too", nearestRule("ecommerce and retail", ROWS), "ecommerce");
eq("…case and space do not hide it", nearestRule("  APP ", ROWS), "apps");
// Only a prefix either way: two segments sharing a few letters are not a match.
eq("an unrelated segment is not guessed at", nearestRule("local", ROWS), null);
eq("…nor is an exact one, which would have been covered", nearestRule("apps", ROWS), null);
eq("…and the empty row is never the near miss", nearestRule("app", [{ segment: null, campaignId: "C", campaignName: "🟡 C" }]), null);

eq("the message names the miss, the likely cause, and the rows that were set",
  describeUnmapped(1980, ["app"], ROWS),
  '1,980 lead(s) carry a segment no row covers ("app"). They stayed where they were. Did the row for "apps" mean "app"? The rows were: apps → 🟡 Apps (August) · ecommerce → 🟡 eCommerce (August).');
eq("…with no near miss it still says what the rows were",
  describeUnmapped(5, ["dental"], ROWS),
  '5 lead(s) carry a segment no row covers ("dental"). They stayed where they were. The rows were: apps → 🟡 Apps (August) · ecommerce → 🟡 eCommerce (August).');
// A run with no rows at all reaches here too; "the rows were:" with nothing
// after it would read like a bug.
eq("…and no rows at all says so plainly",
  describeUnmapped(3, ["app"], []),
  '3 lead(s) carry a segment no row covers ("app"). They stayed where they were. No rows were set at all.');
eq("…a row with no campaign does not count as set",
  describeUnmapped(3, ["x"], [{ segment: "y", campaignId: "", campaignName: "" }]).endsWith("No rows were set at all."), true);

// --- the label ------------------------------------------------------------------
console.log("--- label");
const jobMod = await importTs("@/lib/jobs/campaign-types-types");
eq("the three phases, in order", jobMod.JOB_PHASE_ORDER, ["segmenting", "building", "tagging"]);
eq("…named for a create run", jobMod.JOB_PHASE_ORDER.map((p) => jobMod.jobPhaseLabel(p, "create")), ["Sorting by segment", "Building campaigns", "Tagging the pools"]);
eq("…and a move run", jobMod.jobPhaseLabel("building", "move"), "Moving leads");

console.log(failures === 0 ? "\nall campaign-types checks OK" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
