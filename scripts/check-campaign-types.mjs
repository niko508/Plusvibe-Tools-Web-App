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
const BLUE = "\u{1F535}";
const OPT_OUT = "Opt Out";
const SEP = " - ";
const TRAILING_PAREN = /\s*(\([^()]*\))\s*$/;
const withBlue = (n) => (n.trim().startsWith(BLUE) ? n.trim() : `${BLUE} ${n.trim()}`);
const hasOptOut = (n) => new RegExp(`(^|\\s|-)${OPT_OUT}(\\s|$|\\()`, "i").test(n);
const withOptOut = (n) => {
  const t = n.trim();
  if (hasOptOut(t)) return t;
  const m = t.match(TRAILING_PAREN);
  if (m) return `${t.slice(0, m.index).trim()}${SEP}${OPT_OUT} ${m[1]}`;
  return `${t}${SEP}${OPT_OUT}`;
};
const deriveNames = (n) => ({
  blue: withBlue(n.trim()),
  optOut: withOptOut(n.trim()),
  blueOptOut: withOptOut(withBlue(n.trim())),
});

console.log("--- names");
// The real naming structure: month in a trailing parenthetical, and no
// separator introduced in front of it.
eq("the real worked example", deriveNames("Tree Removal (August)"), {
  blue: "\u{1F535} Tree Removal (August)",
  optOut: "Tree Removal - Opt Out (August)",
  blueOptOut: "\u{1F535} Tree Removal - Opt Out (August)",
});
eq("no dash is introduced before the parenthetical",
  /- \(/.test(deriveNames("Tree Removal (August)").optOut), false);
eq("the parenthetical stays last",
  deriveNames("Tree Removal (August)").optOut.endsWith("(August)"), true);
eq("no parenthetical appends instead", deriveNames("Tree Removal"), {
  blue: "\u{1F535} Tree Removal",
  optOut: "Tree Removal - Opt Out",
  blueOptOut: "\u{1F535} Tree Removal - Opt Out",
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
  new Set(Object.values(deriveNames("Tree Removal (August)"))).size, 3);
// Applying twice must be a no-op, so a re-run can't stack markers.
eq("derivation is idempotent", withOptOut(withOptOut("Tree Removal (August)")),
  "Tree Removal - Opt Out (August)");
eq("blue idempotent", withBlue(withBlue("Tree Removal (August)")), "\u{1F535} Tree Removal (August)");

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

console.log(failures === 0 ? "\nall campaign-types checks OK" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
