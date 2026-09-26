import type { SequenceStep } from "@/lib/plusvibe-types";
import { generalSettings, type GeneralSettings } from "@/lib/general-settings/settings";

// Puts the opt-out spintax at the bottom of every variation in STEP 1 of the
// parent sequence — and nowhere else. Not later steps, not sub-sequences.
//
// A variation ends up with exactly ONE opt-out block, the current one:
//
//   none there            the block is appended
//   an older block        it is swapped for the current one, in place
//   the current block     left as it is
//   two or more blocks    the first becomes the current one, the rest go —
//                         which is also what cleans up a variation an earlier
//                         run stacked a second block onto
//
// The current block and the older ones are in General Settings (Opt-out text);
// the defaults there are opt-out-spintax.ts and opt-out-spintax-previous.ts.
//
// Blocks are recognised by their OPTIONS, not character for character. Once a
// campaign has been through Plusvibe's editor its HTML may carry &quot; for ",
// &#39; or a curly quote for ', &nbsp; for a space, <br> inside the text — the
// same block, spelled differently. An exact match missed all of that, took
// the old block for "no opt-out here" and added a second one under it.
//
// Plusvibe's editor gives <p> no margin, so paragraphs are <div>s separated by
// a non-breaking-space spacer div. That's the same shape the Copy Variations
// tool emits, which is what renders correctly in the campaign editor.

const SPACER = "<div>&nbsp;</div>";

/** Wraps the block the way Plusvibe's editor expects a trailing paragraph. */
export function optOutHtml(): string {
  return `${SPACER}<div>${currentOptOut()}</div>`;
}

/** The block put on step 1 now. */
export function currentOptOut(): string {
  return generalSettings().optOut.current;
}

// --- Reading blocks out of HTML ------------------------------------------------

const ENTITIES: Record<string, string> = {
  quot: '"',
  amp: "&",
  apos: "'",
  nbsp: " ",
  lt: "<",
  gt: ">",
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
  hellip: "...",
  ndash: "-",
  mdash: "-",
};

/** The text a reader sees: tags gone, entities decoded, quotes and spaces made plain. */
export function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[\s ]+/g, " ")
    .trim();
}

/** One option as it is compared: plain, lower-case, one space between words. */
const optionKey = (o: string) => plainText(o).toLowerCase();

export interface SpintaxBlock {
  /** Where the block sits in the HTML: from its "{{" to just after its "}}". */
  start: number;
  end: number;
  /** Its options, compared plain. */
  options: string[];
}

/** Splits "a | b {{x}} | c" on the pipes that aren't inside a nested {{ }}. */
function splitOptions(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner.startsWith("{{", i)) {
      depth++;
      i++;
    } else if (inner.startsWith("}}", i)) {
      depth = Math.max(0, depth - 1);
      i++;
    } else if (inner[i] === "|" && depth === 0) {
      out.push(inner.slice(from, i));
      from = i + 1;
    }
  }
  out.push(inner.slice(from));
  return out;
}

/** Every top-level {{Random | … }} block in the HTML, where it is and what it offers. */
export function findRandomBlocks(html: string): SpintaxBlock[] {
  const blocks: SpintaxBlock[] = [];
  let i = 0;
  while (i < html.length) {
    const open = html.indexOf("{{", i);
    if (open < 0) break;
    // Walk to the matching "}}", nested {{first_name}} and all.
    let depth = 0;
    let j = open;
    let end = -1;
    while (j < html.length) {
      if (html.startsWith("{{", j)) {
        depth++;
        j += 2;
      } else if (html.startsWith("}}", j)) {
        depth--;
        j += 2;
        if (depth === 0) {
          end = j;
          break;
        }
      } else j++;
    }
    if (end < 0) break;
    const inner = plainText(html.slice(open + 2, end - 2));
    const m = /^random\s*\|/i.exec(inner);
    if (m) blocks.push({ start: open, end, options: splitOptions(inner.slice(m[0].length)).map(optionKey).filter(Boolean) });
    i = end;
  }
  return blocks;
}

// --- Which blocks are opt-out blocks ------------------------------------------------

// Worked out once per version of the settings, not once per variation.
let known: { from: GeneralSettings["optOut"]; current: Set<string>; all: Set<string> } | null = null;
function knownOptions() {
  const from = generalSettings().optOut;
  if (known?.from !== from) {
    const opts = (block: string) => findRandomBlocks(block)[0]?.options ?? [];
    const current = new Set(opts(from.current));
    known = { from, current, all: new Set([...current, ...from.previous.flatMap(opts)]) };
  }
  return known;
}

/**
 * An opt-out block: most of its options are opt-out lines this tool has
 * written, now or before. A greeting or sign-off spintax shares none of them;
 * an older wording of the opt-out block shares nearly all.
 */
export function isOptOutBlock(b: SpintaxBlock): boolean {
  if (b.options.length < 5) return false;
  const { all } = knownOptions();
  const hits = b.options.filter((o) => all.has(o)).length;
  return hits / b.options.length >= 0.6;
}

/** The current block, however it is spelled in the HTML. */
export function isCurrentBlock(b: SpintaxBlock): boolean {
  const { current } = knownOptions();
  return b.options.length === current.size && b.options.every((o) => current.has(o));
}

function optOutBlocks(body: string): SpintaxBlock[] {
  return findRandomBlocks(body).filter(isOptOutBlock);
}

/** True if a body carries the current block, and only it. */
export function hasOptOutBlock(body: string): boolean {
  const blocks = optOutBlocks(body);
  return blocks.length === 1 && isCurrentBlock(blocks[0]);
}

/** True if a body carries an older block, or more than one. */
export function hasPreviousOptOutBlock(body: string): boolean {
  const blocks = optOutBlocks(body);
  return blocks.length > 1 || blocks.some((b) => !isCurrentBlock(b));
}

/**
 * Takes a block out of the HTML. When it stood in a <div> of its own — as the
 * appended block does, behind its spacer — the div and the spacer go too, so
 * no empty lines are left behind.
 */
function removeBlock(html: string, b: SpintaxBlock): string {
  const before = html.slice(0, b.start);
  const after = html.slice(b.end);
  const open = /(<div>(?:\s|&nbsp;|<br\s*\/?>)*<\/div>\s*)?<div[^>]*>\s*$/i.exec(before);
  const close = /^\s*<\/div>/i.exec(after);
  if (open && close) return before.slice(0, open.index) + after.slice(close[0].length);
  return before + after;
}

export type OptOutOutcome = "added" | "replaced" | "present";

/** The body with exactly one opt-out block, the current one, and what it took. */
export function withCurrentOptOut(body: string): { body: string; outcome: OptOutOutcome; removed: number } {
  const blocks = optOutBlocks(body);
  if (blocks.length === 0) return { body: `${body}${optOutHtml()}`, outcome: "added", removed: 0 };
  const [first, ...extra] = blocks;
  if (extra.length === 0 && isCurrentBlock(first)) return { body, outcome: "present", removed: 0 };
  let out = body;
  // Later blocks first, so the earlier positions still hold.
  for (const b of [...extra].reverse()) out = removeBlock(out, b);
  out = out.slice(0, first.start) + currentOptOut() + out.slice(first.end);
  return { body: out, outcome: "replaced", removed: extra.length };
}

/** The body with the current block — appended, swapped in, or left as it was. */
export function appendOptOutToBody(body: string): string {
  return withCurrentOptOut(body).body;
}

export interface AppendResult {
  steps: SequenceStep[];
  /** Variation labels that got the block, e.g. ["A", "B"] — swapped ones included. */
  changed: string[];
  /** Of those, the ones whose older opt-out text (or extra copies) was replaced. */
  replaced: string[];
  /** Labels already carrying it, left untouched. */
  alreadyPresent: string[];
}

/**
 * Returns a new sequence array with step 1's variations carrying the block.
 *
 * The whole array is returned because PATCH /campaign/update/campaign REPLACES
 * `sequences` wholesale — every step must be written back, not just the edited
 * one, or the rest of the campaign is destroyed.
 */
export function appendOptOutToStepOne(steps: SequenceStep[]): AppendResult {
  const changed: string[] = [];
  const replaced: string[] = [];
  const alreadyPresent: string[] = [];

  const out = steps.map((s) => {
    if (s.step !== 1) return s;
    return {
      ...s,
      variations: s.variations.map((v) => {
        const r = withCurrentOptOut(v.body ?? "");
        if (r.outcome === "present") {
          alreadyPresent.push(v.variation);
          return v;
        }
        changed.push(v.variation);
        if (r.outcome === "replaced") replaced.push(v.variation);
        return { ...v, body: r.body };
      }),
    };
  });

  return { steps: out, changed, replaced, alreadyPresent };
}
