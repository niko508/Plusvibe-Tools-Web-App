// Unit checks for the Create Follow Up Emails pure logic: offer substitution,
// bulk-paste splitting, and the plain-text -> editor HTML conversion.
//
//   node scripts/check-follow-ups.mjs

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

// --- the functions under test (mirrored from src) ---------------------------
const PLACEHOLDER_RE = /SERVICE\s+OFFERING\s*\/\s*OFFER/gi;
const applyOffer = (text, offer) => {
  let replacements = 0;
  const body = text.replace(PLACEHOLDER_RE, () => {
    replacements += 1;
    return offer;
  });
  return { body, replacements };
};
const hasPlaceholder = (t) => /SERVICE\s+OFFERING\s*\/\s*OFFER/i.test(t);
const splitTemplates = (raw) =>
  (raw ?? "")
    .replace(/\r\n?/g, "\n")
    .split(/^[ \t]*--+[ \t]*$/m)
    .map((c) => c.trim())
    .filter(Boolean);
const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const bodyToHtml = (body) => {
  const blocks = body.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  if (blocks.length === 0) return "";
  return blocks
    .map((b) => `<div>${b.split("\n").map((l) => escapeHtml(l.trim())).join("<br />")}</div>`)
    .join("<div>&nbsp;</div>");
};

// --- offer substitution -----------------------------------------------------
console.log("--- offer substitution");
const OFFER = "helping tree removal companies book more jobs";

eq("replaces the placeholder",
  applyOffer("I reached out about SERVICE OFFERING / OFFER but...", OFFER).body,
  `I reached out about ${OFFER} but...`);
eq("counts one replacement",
  applyOffer("about SERVICE OFFERING / OFFER but", OFFER).replacements, 1);
eq("replaces every occurrence",
  applyOffer("SERVICE OFFERING / OFFER and SERVICE OFFERING / OFFER", OFFER).replacements, 2);
eq("no placeholder means no replacement",
  applyOffer("plain follow-up text", OFFER).replacements, 0);
eq("leaves text without the marker untouched",
  applyOffer("plain follow-up text", OFFER).body, "plain follow-up text");

// Tolerant of how the marker gets retyped by hand.
eq("case-insensitive", applyOffer("about Service Offering / Offer but", OFFER).replacements, 1);
eq("tolerates no spaces round the slash",
  applyOffer("about SERVICE OFFERING/OFFER but", OFFER).replacements, 1);
eq("tolerates extra spacing",
  applyOffer("about SERVICE   OFFERING  /  OFFER but", OFFER).replacements, 1);

// But NOT tolerant of a partial marker — a half-written placeholder must show
// up as unsubstituted rather than being silently mangled.
eq("a partial marker is left alone",
  applyOffer("about SERVICE OFFERING but", OFFER).replacements, 0);
eq("OFFER alone is left alone", applyOffer("a great OFFER for you", OFFER).replacements, 0);

// The offer text itself must not be re-scanned (no runaway substitution).
eq("an offer containing the marker substitutes once",
  applyOffer("x SERVICE OFFERING / OFFER y", "SERVICE OFFERING / OFFER").replacements, 1);

eq("hasPlaceholder agrees with applyOffer", hasPlaceholder("a SERVICE OFFERING / OFFER b"), true);
eq("hasPlaceholder false for partial", hasPlaceholder("a SERVICE OFFERING b"), false);

// --- the real templates -----------------------------------------------------
console.log("--- shipped default templates");
const defaultsSrc = readFileSync("src/lib/follow-ups/default-templates.ts", "utf8");
const defaults = [...defaultsSrc.matchAll(/`([\s\S]*?)`,\n/g)].map((m) => m[1]);
eq("two starter templates ship", defaults.length, 2);
for (const [i, t] of defaults.entries()) {
  eq(`template ${i + 1} carries the placeholder`, hasPlaceholder(t), true);
  eq(`template ${i + 1} substitutes exactly once`, applyOffer(t, OFFER).replacements, 1);
  eq(`template ${i + 1} keeps its signature`, t.trim().endsWith("{{sender_first_name}}"), true);
  // Spintax and Liquid must survive substitution intact.
  const after = applyOffer(t, OFFER).body;
  eq(`template ${i + 1} keeps its Liquid guard`, after.includes("{% if first_name != blank %}"), true);
  eq(`template ${i + 1} keeps its {% endif %}`, after.includes("{% endif %}"), true);
  eq(`template ${i + 1} spintax braces balance`,
    (after.match(/\{\{/g) || []).length, (after.match(/\}\}/g) || []).length);
  eq(`template ${i + 1} has no leftover marker`, hasPlaceholder(after), false);
}

// --- bulk paste splitting ---------------------------------------------------
console.log("--- bulk paste splitting");
eq("splits on a bare -- line", splitTemplates("one\n\n--\n\ntwo"), ["one", "two"]);
eq("tolerates a leading separator", splitTemplates("--\none\n--\ntwo"), ["one", "two"]);
eq("tolerates a trailing separator", splitTemplates("one\n--\ntwo\n--\n"), ["one", "two"]);
eq("tolerates longer rules", splitTemplates("one\n----\ntwo"), ["one", "two"]);
eq("tolerates indentation on the rule", splitTemplates("one\n  --  \ntwo"), ["one", "two"]);
eq("empty input yields nothing", splitTemplates(""), []);
eq("blank chunks are dropped", splitTemplates("one\n--\n\n--\ntwo"), ["one", "two"]);
eq("CRLF handled", splitTemplates("one\r\n--\r\ntwo"), ["one", "two"]);
eq("single template with no separator", splitTemplates("just one"), ["just one"]);
// An em/en dash line is NOT a separator, and neither is a dash inside text.
eq("a dash inside a line is not a separator",
  splitTemplates("Hey -- there\nmore"), ["Hey -- there\nmore"]);
// The real paste: two templates round-trip.
eq("the two shipped templates round-trip through a paste",
  splitTemplates(defaults.map((d) => d.trim()).join("\n\n--\n\n")).length, 2);

// --- html conversion --------------------------------------------------------
console.log("--- html conversion");
eq("paragraphs become divs with spacers",
  bodyToHtml("one\n\ntwo"), "<div>one</div><div>&nbsp;</div><div>two</div>");
eq("single newline becomes a br", bodyToHtml("a\nb"), "<div>a<br />b</div>");
eq("empty body yields empty html", bodyToHtml(""), "");
eq("blank-only body yields empty html", bodyToHtml("\n\n  \n"), "");
// Spintax and Liquid contain no HTML-special characters, so they pass through.
const spin = "{{Random | a | b}} {% if first_name != blank %}x{% endif %}";
eq("spintax survives conversion", bodyToHtml(spin), `<div>${spin}</div>`);
eq("ampersands are escaped", bodyToHtml("Tom & Jerry"), "<div>Tom &amp; Jerry</div>");
eq("angle brackets are escaped", bodyToHtml("a <b> c"), "<div>a &lt;b&gt; c</div>");
// The shipped templates convert to the expected number of paragraphs.
for (const [i, t] of defaults.entries()) {
  const html = bodyToHtml(applyOffer(t, OFFER).body);
  eq(`template ${i + 1} converts to 4 paragraphs`,
    (html.match(/<div>&nbsp;<\/div>/g) || []).length, 3);
  eq(`template ${i + 1} html keeps the offer`, html.includes(OFFER), true);
}

console.log(failures === 0 ? "\nall follow-up checks OK" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
