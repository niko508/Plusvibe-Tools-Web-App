// Verifies both opt-out blocks character for character. This copy goes out to
// real recipients, so a stray edit to one option must fail loudly rather than
// ship.
//
//   current   OPT_OUT_SPINTAX: the 18 × 19 cross product of PHRASE_TEMPLATES
//             and REPLY_TOKENS, then EXTRA_OPTIONS — 447 options
//   previous  PREVIOUS_OPT_OUT_SPINTAX: 23 × 27 — 621 options. No longer
//             appended, only recognised, so it must never drift either.
//
//   node scripts/check-opt-out-spintax.mjs

import { readFileSync } from "fs";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (ok) console.log(`PASS  ${label}`);
  else {
    failures++;
    console.log(`FAIL  ${label}${detail ? `\n   ${detail}` : ""}`);
  }
};

// Pull the literals out of the TS source without a compiler.
function read(file) {
  const src = readFileSync(new URL(`../src/lib/campaign-types/${file}`, import.meta.url), "utf8");
  return {
    literal(name) {
      const m = src.match(new RegExp(`export const ${name}[^\`]*\`([\\s\\S]*?)\`;`));
      if (!m) throw new Error(`could not find ${name}`);
      return m[1];
    },
    array(name) {
      const m = src.match(new RegExp(`export const ${name}[^\\[]*\\[([\\s\\S]*?)\\n\\];`));
      if (!m) throw new Error(`could not find ${name}`);
      return [...m[1].matchAll(/^\s*[`"](.*)[`"],$/gm)].map((x) => x[1]);
    },
  };
}

function verify(label, block, replies, phrases, extras, counts) {
  console.log(`--- ${label}`);
  check("wrapped in {{Random | … }}", block.startsWith("{{Random | ") && block.endsWith("}}"));
  check(`${counts.replies} reply tokens`, replies.length === counts.replies, `got ${replies.length}`);
  check(`${counts.phrases} phrasings`, phrases.length === counts.phrases, `got ${phrases.length}`);
  check(`${counts.extras} one-off lines`, extras.length === counts.extras, `got ${extras.length}`);
  const options = block.slice("{{Random | ".length, -"}}".length).split(" | ");
  check(`${counts.total} options`, options.length === counts.total, `got ${options.length}`);

  // The point: rebuild from the parts and compare option by option.
  const expected = [...replies.flatMap((r) => phrases.map((p) => p.replaceAll("{P}", r))), ...extras];
  let first = null;
  for (let i = 0; i < Math.max(options.length, expected.length); i++) {
    if (options[i] !== expected[i]) {
      first = i;
      break;
    }
  }
  check("every option matches, in order", first === null,
    first === null ? "" : `option ${first}:\n   got      ${JSON.stringify(options[first])}\n   expected ${JSON.stringify(expected[first])}`);
  check("no empty options", options.every((o) => o.trim().length > 0));
  check("no option contains a stray pipe", options.every((o) => !o.includes("|")));
  check("every option quotes its reply", options.every((o) => /"[^"]+"/.test(o)));
  check("no curly quotes", !/[‘’“”]/.test(block));
  check("all options unique", new Set(options).size === options.length, `${new Set(options).size} unique`);
  return options;
}

const cur = read("opt-out-spintax.ts");
const current = verify("current block", cur.literal("OPT_OUT_SPINTAX"), cur.array("REPLY_TOKENS"), cur.array("PHRASE_TEMPLATES"), cur.array("EXTRA_OPTIONS"),
  { replies: 19, phrases: 18, extras: 105, total: 447 });
check("the one-off lines end with the wave — no emoji", current.at(-1) === 'Not a match? Reply "wave" and I\'ll leave with a smile.');
check("…and no option anywhere carries an emoji", current.every((o) => !/\p{Extended_Pictographic}/u.test(o)));
check("…and the first is the baton", current[342] === 'Not your thing? Reply "pass the baton" and I\'ll hand this to someone else.');

const prev = read("opt-out-spintax-previous.ts");
const previous = verify("previous block", prev.literal("PREVIOUS_OPT_OUT_SPINTAX"), prev.array("PREVIOUS_REPLY_TOKENS"), prev.array("PREVIOUS_PHRASE_TEMPLATES"), [],
  { replies: 27, phrases: 23, extras: 0, total: 621 });
check("previous keeps its em dash", previous.filter((o) => o.includes("—")).length === 27);

console.log("--- the two are told apart");
const curBlock = cur.literal("OPT_OUT_SPINTAX");
const prevBlock = prev.literal("PREVIOUS_OPT_OUT_SPINTAX");
check("neither block contains the other", !curBlock.includes(prevBlock) && !prevBlock.includes(curBlock));

console.log(failures === 0 ? "\nspintax blocks OK" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
