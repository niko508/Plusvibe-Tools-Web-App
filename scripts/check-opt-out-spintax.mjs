// Verifies OPT_OUT_SPINTAX is exactly the PHRASE_TEMPLATES × REPLY_TOKENS cross
// product, in order. This copy goes out to real recipients, so a stray edit to
// one of the 621 options must fail loudly rather than ship.
//
//   node scripts/check-opt-out-spintax.mjs

import { readFileSync } from "fs";

const src = readFileSync(
  new URL("../src/lib/campaign-types/opt-out-spintax.ts", import.meta.url),
  "utf8"
);

// Pull the three exported literals out of the TS source without a compiler.
function backtickLiteral(name) {
  const m = src.match(new RegExp(`export const ${name}[^\`]*\`([\\s\\S]*?)\`;`));
  if (!m) throw new Error(`could not find ${name}`);
  return m[1];
}
function backtickArray(name) {
  const m = src.match(new RegExp(`export const ${name}[^\\[]*\\[([\\s\\S]*?)\\n\\];`));
  if (!m) throw new Error(`could not find ${name}`);
  return [...m[1].matchAll(/^\s*[`"](.*)[`"],$/gm)].map((x) => x[1]);
}

const block = backtickLiteral("OPT_OUT_SPINTAX");
const replies = backtickArray("REPLY_TOKENS");
const phrases = backtickArray("PHRASE_TEMPLATES");

let failures = 0;
const check = (label, ok, detail = "") => {
  if (ok) {
    console.log(`PASS  ${label}`);
  } else {
    failures++;
    console.log(`FAIL  ${label}${detail ? `\n   ${detail}` : ""}`);
  }
};

check("block is wrapped in {{Random | … }}", block.startsWith("{{Random | ") && block.endsWith("}}"));
check("replies parsed", replies.length === 27, `got ${replies.length}`);
check("phrases parsed", phrases.length === 23, `got ${phrases.length}`);

const inner = block.slice("{{Random | ".length, -"}}".length);
const options = inner.split(" | ");
check("621 options", options.length === 621, `got ${options.length}`);

// The whole point: rebuild from the two axes and compare option by option.
const expected = replies.flatMap((r) => phrases.map((p) => p.replaceAll("{P}", r)));
check("expected cross product is 621", expected.length === 621, `got ${expected.length}`);

let firstMismatch = null;
for (let i = 0; i < Math.max(options.length, expected.length); i++) {
  if (options[i] !== expected[i]) {
    firstMismatch = i;
    break;
  }
}
check(
  "every option matches the cross product",
  firstMismatch === null,
  firstMismatch === null
    ? ""
    : `option ${firstMismatch} (reply "${replies[Math.floor(firstMismatch / 23)]}", phrase ${firstMismatch % 23}):\n   got      ${JSON.stringify(options[firstMismatch])}\n   expected ${JSON.stringify(expected[firstMismatch])}`
);

// Guard the details that are easy to lose to an editor: the em dash, the
// curly-free straight quotes, and no doubled/missing separators.
check("no empty options", options.every((o) => o.trim().length > 0));
check("no option contains a stray pipe", options.every((o) => !o.includes("|")));
check("every option quotes its reply token", options.every((o) => /"[^"]+"/.test(o)));
check("em dash preserved", options.filter((o) => o.includes("—")).length === 27,
  `${options.filter((o) => o.includes("—")).length} options with an em dash, expected 27 (one per reply)`);
check("no curly quotes", !/[‘’“”]/.test(block));
check("all options unique", new Set(options).size === 621, `${new Set(options).size} unique`);

console.log(failures === 0 ? "\nspintax block OK" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
