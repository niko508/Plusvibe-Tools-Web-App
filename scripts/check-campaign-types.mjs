// Unit checks for the Create All Campaign Types pure logic: name derivation,
// the 4-way split, ESP classification and the step-1 spintax append.
//
//   node scripts/check-campaign-types.mjs

import { readFileSync } from "fs";

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
const BLUE = "🔵";
const OPT_OUT = "Opt Out";
const SEP = " - ";
const withBlue = (n) => (n.trim().startsWith(BLUE) ? n.trim() : `${BLUE} ${n.trim()}`);
const hasOptOut = (n) => n.split(SEP).some((p) => p.trim().toLowerCase() === OPT_OUT.toLowerCase());
const withOptOut = (n) => {
  const t = n.trim();
  if (hasOptOut(t)) return t;
  const parts = t.split(SEP);
  if (parts.length < 2) return `${t}${SEP}${OPT_OUT}`;
  return [...parts.slice(0, -1), OPT_OUT, parts[parts.length - 1]].join(SEP);
};
const deriveNames = (n) => ({
  blue: withBlue(n.trim()),
  optOut: withOptOut(n.trim()),
  blueOptOut: withOptOut(withBlue(n.trim())),
});

console.log("--- names");
eq("the spec's worked example", deriveNames("Tree Removal - August"), {
  blue: "🔵 Tree Removal - August",
  optOut: "Tree Removal - Opt Out - August",
  blueOptOut: "🔵 Tree Removal - Opt Out - August",
});
eq("no separator appends instead of inserting", deriveNames("Tree Removal"), {
  blue: "🔵 Tree Removal",
  optOut: "Tree Removal - Opt Out",
  blueOptOut: "🔵 Tree Removal - Opt Out",
});
eq("three segments keep the last one last", withOptOut("Roofing - UK - August"),
  "Roofing - UK - Opt Out - August");
eq("blue is not doubled", withBlue("🔵 Tree Removal - August"), "🔵 Tree Removal - August");
eq("opt out is not doubled", withOptOut("Tree Removal - Opt Out - August"),
  "Tree Removal - Opt Out - August");
eq("opt out match is case-insensitive", withOptOut("Tree Removal - OPT OUT - August"),
  "Tree Removal - OPT OUT - August");
eq("surrounding whitespace trimmed", deriveNames("  Tree Removal - August  ").optOut,
  "Tree Removal - Opt Out - August");
// A hyphen that is not a " - " separator must not be treated as one.
eq("hyphenated word is not a separator", withOptOut("Pre-Sales Outreach"),
  "Pre-Sales Outreach - Opt Out");
eq("derived names are all distinct", new Set(Object.values(deriveNames("Tree Removal - August"))).size, 3);

// --- split -----------------------------------------------------------------
const splitCounts = (ms, other) => {
  const blue = Math.ceil(ms / 2);
  const optOut = Math.floor(other / 2);
  return { source: other - optOut, optOut, blue, blueOptOut: ms - blue };
};

console.log("--- split");
eq("the spec's 20k / 10k example", splitCounts(10000, 10000),
  { source: 5000, optOut: 5000, blue: 5000, blueOptOut: 5000 });
eq("no microsoft leads", splitCounts(0, 100), { source: 50, optOut: 50, blue: 0, blueOptOut: 0 });
eq("all microsoft leads", splitCounts(100, 0), { source: 0, optOut: 0, blue: 50, blueOptOut: 50 });
eq("odd microsoft favours the blue original", splitCounts(7, 0),
  { source: 0, optOut: 0, blue: 4, blueOptOut: 3 });
eq("odd others favour the source", splitCounts(0, 7), { source: 4, optOut: 3, blue: 0, blueOptOut: 0 });
eq("empty campaign", splitCounts(0, 0), { source: 0, optOut: 0, blue: 0, blueOptOut: 0 });
eq("single lead stays put", splitCounts(0, 1), { source: 1, optOut: 0, blue: 0, blueOptOut: 0 });
// Conservation: nothing may be invented or lost, at any size.
for (const [ms, other] of [[0,0],[1,0],[0,1],[7,13],[9999,1],[10000,10000],[3,4],[12345,54321]]) {
  const c = splitCounts(ms, other);
  eq(`conserves ${ms}+${other}`, c.source + c.optOut + c.blue + c.blueOptOut, ms + other);
  eq(`microsoft only to blue (${ms}+${other})`, c.blue + c.blueOptOut, ms);
  eq(`others only to source/optOut (${ms}+${other})`, c.source + c.optOut, other);
}

// planSplit assigns disjoint, complete lead sets
const planSplit = (microsoft, other) => {
  const counts = splitCounts(microsoft.length, other.length);
  return {
    counts,
    moves: [
      { destination: "blue", leads: microsoft.slice(0, counts.blue) },
      { destination: "blueOptOut", leads: microsoft.slice(counts.blue) },
      { destination: "optOut", leads: other.slice(counts.source) },
    ],
  };
};
const ms = Array.from({ length: 7 }, (_, i) => `m${i}`);
const ot = Array.from({ length: 5 }, (_, i) => `o${i}`);
const plan = planSplit(ms, ot);
const moved = plan.moves.flatMap((m) => m.leads);
eq("moved leads are unique", new Set(moved).size, moved.length);
eq("moved count matches plan", moved.length, plan.counts.blue + plan.counts.blueOptOut + plan.counts.optOut);
eq("leads left in source", ot.filter((o) => !moved.includes(o)).length, plan.counts.source);
eq("no microsoft lead stays in source", ms.every((m) => moved.includes(m)), true);

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
const hasBlock = (b) => b.includes(SPINTAX);
const appendBody = (b) => (hasBlock(b) ? b : `${b}${SPACER}<div>${SPINTAX}</div>`);
const appendStepOne = (steps) => {
  const changed = [], already = [];
  const out = steps.map((s) => {
    if (s.step !== 1) return s;
    return { ...s, variations: s.variations.map((v) => {
      const body = v.body ?? "";
      if (hasBlock(body)) { already.push(v.variation); return v; }
      changed.push(v.variation);
      return { ...v, body: appendBody(body) };
    })};
  });
  return { steps: out, changed, alreadyPresent: already };
};

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


// --- companion matching -----------------------------------------------------
const normalizeName = (n) => n.replace(/\uFE0F/g, "").replace(/\s+/g, " ").trim().toLowerCase();
const matchCompanions = (sourceName, campaigns, sourceId) => {
  const names = deriveNames(sourceName);
  const pool = campaigns.filter((c) => c.campaignType !== "subseq" && c.id !== sourceId);
  const byName = new Map();
  for (const c of pool) {
    const k = normalizeName(c.name);
    byName.has(k) ? byName.get(k).push(c) : byName.set(k, [c]);
  }
  const roles = [
    { role: "blue", expectedName: names.blue },
    { role: "optOut", expectedName: names.optOut },
    { role: "blueOptOut", expectedName: names.blueOptOut },
  ];
  const used = new Set();
  const matches = roles.map(({ role, expectedName }) => {
    const found = byName.get(normalizeName(expectedName)) ?? [];
    if (found.length > 1) return { role, expectedName, match: null, ambiguous: true };
    const c = found[0];
    if (!c || used.has(c.id)) return { role, expectedName, match: null, ambiguous: false };
    used.add(c.id);
    return { role, expectedName, match: c, ambiguous: false };
  });
  return { matches, complete: matches.every((m) => m.match !== null) };
};

console.log("--- companion matching");
const SRC = { id: "s1", name: "Tree Removal - August" };
const full = [
  SRC,
  { id: "b1", name: "\u{1F535} Tree Removal - August" },
  { id: "o1", name: "Tree Removal - Opt Out - August" },
  { id: "bo1", name: "\u{1F535} Tree Removal - Opt Out - August" },
];
const r = matchCompanions(SRC.name, full, SRC.id);
eq("all three companions found", r.complete, true);
eq("blue maps to the blue campaign", r.matches[0].match.id, "b1");
eq("optOut maps to the opt out campaign", r.matches[1].match.id, "o1");
eq("blueOptOut maps to the blue opt out campaign", r.matches[2].match.id, "bo1");

// The source must never be matched into a role - it would move leads to itself.
const selfy = matchCompanions("Tree Removal - August", [SRC], SRC.id);
eq("source is excluded from the pool", selfy.matches.every((m) => m.match === null), true);
eq("incomplete when companions are missing", selfy.complete, false);

// Human duplication is sloppy: case, doubled spaces, missing variation selector.
const sloppy = matchCompanions(SRC.name, [
  { id: "b1", name: "\u{1F535}\uFE0F  tree removal  -  August " },
  { id: "o1", name: "TREE REMOVAL - OPT OUT - AUGUST" },
  { id: "bo1", name: "\u{1F535} Tree Removal - Opt Out - August" },
], SRC.id);
eq("tolerates case, spacing and the emoji variation selector", sloppy.complete, true);
eq("sloppy blue still maps correctly", sloppy.matches[0].match.id, "b1");

// Sub-sequences are separate campaign records and are never a role.
const withSub = matchCompanions(SRC.name, [
  { id: "sub", name: "\u{1F535} Tree Removal - August", campaignType: "subseq" },
  { id: "b1", name: "\u{1F535} Tree Removal - August" },
], SRC.id);
eq("sub-sequences are excluded", withSub.matches[0].match.id, "b1");

// Two campaigns with the same name: refuse rather than guess.
const dupes = matchCompanions(SRC.name, [
  { id: "b1", name: "\u{1F535} Tree Removal - August" },
  { id: "b2", name: "\u{1F535} Tree Removal - August" },
], SRC.id);
eq("duplicate names are ambiguous, not guessed", dupes.matches[0].ambiguous, true);
eq("ambiguous role is left unmatched", dupes.matches[0].match, null);

// A near-miss must not be matched to the wrong campaign.
const nearMiss = matchCompanions(SRC.name, [
  { id: "x", name: "\u{1F535} Tree Removal - September" },
  { id: "y", name: "Tree Removal - Opt Out - September" },
], SRC.id);
eq("a different month does not match", nearMiss.matches.every((m) => m.match === null), true);

// One campaign cannot fill two roles.
const shared = matchCompanions("Tree Removal", [
  { id: "z", name: "Tree Removal - Opt Out" },
], "s1");
eq("a campaign fills at most one role",
  shared.matches.filter((m) => m.match && m.match.id === "z").length, 1);

console.log(failures === 0 ? "\nall campaign-types checks OK" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
