// Unit checks for Create Email Copy Variations' paste parser: the older
// "VARIANT n — name" blocks, the variation generator's "EMAIL n — Template …"
// blocks, and the plain separator fallback. Imports the REAL module.
//
//   node scripts/check-copy-variations-parse.mjs

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

const { parseVariants } = await importTs("@/app/tools/copy-variations/parse");

const RULE = "═══════════════════════════════════════════";
const OPEN = "{% if first_name != blank %} {{Random | Hey {{first_name}}, | Hi {{first_name}},}} {% else %} {{Random | Hey, | Hi,}} {% endif %}";
const SIGN = "{{Random | Thanks, | Best, | Thx,}}\n{{sender_first_name}}";

// The generator's output: a header, a rule, the email, a rule, the next header.
const GENERATED = [
  "EMAIL 1 — Template 1: Conditional Opening V1 · Arrangement 10",
  RULE,
  `${OPEN} {{Random | one question and I'll leave you be. | just one question.}}`,
  "{{Random | If my team & I | If we}} could get your company named as the answer, {{Random | would you be open to hearing how it works? | would that be of interest to you?}}",
  "Without any ad spend, and with nothing to pause in your current setup.",
  SIGN,
  RULE,
  "EMAIL 2 — Template 1: Conditional Opening V1 · Arrangement 4",
  RULE,
  OPEN,
  "Would you be interested?",
  SIGN,
  "P.S. You wouldn't need to write, build or set up anything. Our team does all of it.",
  RULE,
  "EMAIL 3 — Template 3: Two things · Arrangement 3",
  RULE,
  OPEN,
  "{{Random | Two things: | Just two things:}}",
  "",
  "1. We could get your company recommended when buyers ask ChatGPT which {% if company_category != blank %}{{company_category}}{% else %}software companies{% endif %} to look at.",
  "2. It sits apart from your current setup, so nothing gets paused or undone.",
  "",
  SIGN,
].join("\n");

console.log("--- EMAIL n — Template … blocks");
{
  const r = parseVariants(GENERATED);
  eq("one variant per email, not one per header and one per body", r.variants.length, 3);
  eq("…numbered and named from their headers", r.variants.map((v) => [v.number, v.name]), [
    [1, "Template 1: Conditional Opening V1 · Arrangement 10"],
    [2, "Template 1: Conditional Opening V1 · Arrangement 4"],
    [3, "Template 3: Two things · Arrangement 3"],
  ]);
  eq("no fallback warning", r.warnings, []);
  eq("the header is not part of the body", r.variants.some((v) => /EMAIL \d/.test(v.body)), false);
  eq("the body starts with the opening and ends with the sign-off", [r.variants[0].body.startsWith("{% if first_name"), r.variants[0].body.endsWith("{{sender_first_name}}")], [true, true]);
  eq("a P.S. stays with its email", r.variants[1].body.endsWith("Our team does all of it."), true);
  eq("spintax and Liquid are kept exactly", r.variants[2].body.includes("{% if company_category != blank %}{{company_category}}{% else %}software companies{% endif %}"), true);
  eq("…and blank lines inside an email too", r.variants[2].body.includes("Just two things:}}\n\n1. We could"), true);
}

console.log("--- a rule above each header too");
{
  const boxed = `${RULE}\nEMAIL 14 — Template 7: New Method + Case Study · Arrangement 10\n${RULE}\n\n${OPEN} we found a way.\n\n${SIGN}\n${RULE}\nEMAIL 15 — Template 7: New Method + Case Study · Arrangement 4\n${RULE}\n${OPEN} another.\n${SIGN}`;
  const r = parseVariants(boxed);
  eq("still one variant per email", [r.variants.length, r.variants.map((v) => v.number)], [2, [14, 15]]);
  eq("…with nothing before the first header to warn about", r.warnings, []);
}

console.log("--- the older VARIANT n format still works");
{
  const r = parseVariants(`VARIANT 1 — Poke-the-bear\n${RULE}\n\nBody one\n\n${RULE}\nVARIANT 2 — Value-prop\n${RULE}\n\nBody two`);
  eq("two variants, named", r.variants.map((v) => [v.number, v.name, v.body]), [[1, "Poke-the-bear", "Body one"], [2, "Value-prop", "Body two"]]);
}

console.log("--- no headers at all");
{
  const r = parseVariants(`First body\n${RULE}\nSecond body`);
  eq("split on the separators, with a warning that names both header kinds", [r.variants.length, r.warnings[0]], [2, 'No "VARIANT n" or "EMAIL n" headers found — split into 2 blocks on the separator lines instead.']);
}

console.log("--- the HTML each email becomes");
{
  const S = "<div>&nbsp;</div>";
  // One paragraph per line, no blank lines between — the generator's shape.
  const r = parseVariants(`EMAIL 14 — Template 7 · Arrangement 10\n${RULE}\n${OPEN} we found a way.\nOne of our clients is now at 4x more demos.\n{{Random | Could I explain? | Could I share how it works?}}\n${SIGN}`);
  const html = r.variants[0].html;
  eq("every line is its own paragraph, with a blank line between", html.split(S).length, 5);
  eq("…nothing packed together with <br />", html.includes("<br />"), false);
  eq("…in order, with Liquid and spintax as they were", html.split(S)[0], `<div>${OPEN} we found a way.</div>`);

  // The Two things email: a list between blank lines.
  const two = parseVariants(`EMAIL 5 — Template 3: Two things · Arrangement 3\n${RULE}\n${OPEN}\n{{Random | Two things: | Just two things:}}\n\n1. We could get your company recommended.\n2. It sits apart from your current setup, so nothing gets paused or undone.\n\n{{Random | Are there any specific company types you'd like to connect with? | Are there certain types?}}\n${SIGN}`).variants[0].html;
  const paras = two.split(S);
  eq("a list stays together, a line per item, numbers kept", paras.find((p) => p.includes("1. We could")), "<div>1. We could get your company recommended.<br />2. It sits apart from your current setup, so nothing gets paused or undone.</div>");
  eq("…with a blank line before and after it, and between every other line", paras.length, 6);
  eq("blank lines in the paste don't stack extra space", two.includes(`${S}${S}`), false);
  const bullets = parseVariants(`VARIANT 1 — x\nIntro line\n* first\n* second\nClosing line`).variants[0].html;
  eq("bullets stay together too", bullets, `<div>Intro line</div>${S}<div>* first<br />* second</div>${S}<div>Closing line</div>`);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
