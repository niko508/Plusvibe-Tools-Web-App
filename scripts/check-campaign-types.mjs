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
const { splitCounts, planSplit } = await importTs("@/lib/campaign-types/split");
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
const normalizeName = (n) => n.replace(/\uFE0F/g, "").replace(/\s+/g, " ").trim().toLowerCase();
const looseKey = (n) => normalizeName(n).replace(/-/g, " ").replace(/\s+/g, " ").trim();
const matchCompanions = (sourceName, campaigns, sourceId) => {
  const names = deriveNames(sourceName);
  const pool = campaigns.filter((c) => c.campaignType !== "subseq" && c.id !== sourceId);
  const byName = new Map(), byLoose = new Map();
  for (const c of pool) {
    for (const [map, key] of [[byName, normalizeName(c.name)], [byLoose, looseKey(c.name)]]) {
      map.has(key) ? map.get(key).push(c) : map.set(key, [c]);
    }
  }
  const roles = [
    { role: "blue", expectedName: names.blue },
    { role: "optOut", expectedName: names.optOut },
    { role: "blueOptOut", expectedName: names.blueOptOut },
  ];
  const used = new Set();
  const matches = roles.map(({ role, expectedName }) => {
    const exact = byName.get(normalizeName(expectedName)) ?? [];
    if (exact.length > 1) return { role, expectedName, match: null, ambiguous: true };
    let candidate = exact[0], loose = false;
    if (!candidate) {
      const near = (byLoose.get(looseKey(expectedName)) ?? []).filter((c) => !used.has(c.id));
      if (near.length > 1) return { role, expectedName, match: null, ambiguous: true };
      candidate = near[0];
      loose = !!candidate;
    }
    if (!candidate || used.has(candidate.id)) return { role, expectedName, match: null, ambiguous: false };
    used.add(candidate.id);
    return { role, expectedName, match: candidate, ambiguous: false, loose };
  });
  return { matches, complete: matches.every((m) => m.match !== null) };
};

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

console.log(failures === 0 ? "\nall campaign-types checks OK" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
