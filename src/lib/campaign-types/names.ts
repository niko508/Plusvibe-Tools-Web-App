// Derives the five companion campaign names from one source name.
//
//   Tree Removal (August)               (source, untouched)
//   🔵 Tree Removal (August)            Microsoft leads
//   Tree Removal - Opt Out (August)     opt-out copy on step 1
//   🔵 Tree Removal - Opt Out (August)
//   Tree Removal - Signature (August)   step 1 signs off with the signature
//   🔵 Tree Removal - Signature (August)
//
// The blue circle marks the Microsoft-only copies; "Opt Out" marks the copies
// whose step 1 carries the opt-out spintax; "Signature" marks the copies whose
// step 1 signs off with {{sender_signature}} instead of {{sender_first_name}}.
//
// Google campaigns are now named with a yellow circle in front, so a source
// called "🟡 Tree Removal (August)" gives:
//
//   🟡 Tree Removal - Opt Out (August)     the plain copies keep the 🟡
//   🔵 Tree Removal - Opt Out (August)     the 🔵 copies swap it for the 🔵
//
// A source with no 🟡 is named exactly as before: the circle is mirrored from
// the source, never added to it.
//
// The month sits in a trailing parenthetical and stays last, with NO separator
// introduced in front of it — the marker goes before the parenthetical, not
// after the campaign name.

export const BLUE = "🔵";
export const YELLOW = "🟡";
export const OPT_OUT = "Opt Out";
export const SIGNATURE = "Signature";
const SEP = " - ";

/** A leading yellow circle, with or without the invisible variation selector. */
const LEADING_YELLOW = /^🟡️?\s*/;

export function hasYellow(name: string): boolean {
  return LEADING_YELLOW.test(name.trim());
}

/** The name without its leading 🟡 — what the 🔵 copies are named from. */
export function stripYellow(name: string): string {
  return name.trim().replace(LEADING_YELLOW, "").trim();
}

/** Prefixes the yellow circle, leaving one space and never doubling up. */
export function withYellow(name: string): string {
  const trimmed = name.trim();
  if (hasYellow(trimmed)) return trimmed;
  return `${YELLOW} ${trimmed}`;
}

export interface DerivedNames {
  blue: string;
  optOut: string;
  blueOptOut: string;
  signature: string;
  blueSignature: string;
}

/**
 * Prefixes the blue circle, leaving one space and never doubling up if the
 * name already starts with it.
 */
export function withBlue(name: string): string {
  const trimmed = name.trim();
  if (trimmed.startsWith(BLUE)) return trimmed;
  return `${BLUE} ${trimmed}`;
}

/** A trailing "(August)"-style parenthetical, captured with its leading space. */
const TRAILING_PAREN = /\s*(\([^()]*\))\s*$/;

/**
 * Adds a marker, keeping any trailing parenthetical last:
 *
 *   "Tree Removal (August)"  ->  "Tree Removal - Opt Out (August)"
 *   "Tree Removal"           ->  "Tree Removal - Opt Out"
 *
 * No separator is ever introduced in front of the parenthetical — the month
 * keeps the single space it already had, so the campaigns read the same way
 * they do when created by hand.
 *
 * The blue prefix is preserved, so this composes with withBlue() either way.
 */
function withMarker(name: string, marker: string): string {
  const trimmed = name.trim();
  if (hasMarker(trimmed, marker)) return trimmed;

  const m = trimmed.match(TRAILING_PAREN);
  if (m) {
    const head = trimmed.slice(0, m.index).trim();
    return `${head}${SEP}${marker} ${m[1]}`;
  }
  return `${trimmed}${SEP}${marker}`;
}

/** True if a name already carries the marker (case-insensitive). */
function hasMarker(name: string, marker: string): boolean {
  return new RegExp(`(^|\\s|-)${marker}(\\s|$|\\()`, "i").test(name);
}

export function withOptOut(name: string): string {
  return withMarker(name, OPT_OUT);
}

/** True if a name already carries the "Opt Out" marker (case-insensitive). */
export function hasOptOut(name: string): boolean {
  return hasMarker(name, OPT_OUT);
}

export function withSignature(name: string): string {
  return withMarker(name, SIGNATURE);
}

/** True if a name already carries the "Signature" marker (case-insensitive). */
export function hasSignature(name: string): boolean {
  return hasMarker(name, SIGNATURE);
}

/**
 * The names for a run. When the originals are turned into Opt Out (Opt Out
 * only), the Signature copies are made from the converted original and carry
 * its opt-out line, so they are named from its Opt Out name:
 *
 *   🟡 Tree Removal (August)  ->  🟡 Tree Removal - Opt Out (August)        (the original, renamed)
 *                                 🔵 Tree Removal - Opt Out (August)
 *                                 🟡 Tree Removal - Opt Out - Signature (August)
 *                                 🔵 Tree Removal - Opt Out - Signature (August)
 */
export function runNames(sourceName: string, convert: boolean): DerivedNames {
  const names = deriveNames(sourceName);
  if (!convert) return names;
  const converted = deriveNames(names.optOut);
  return { ...names, signature: converted.signature, blueSignature: converted.blueSignature };
}

export function deriveNames(sourceName: string): DerivedNames {
  // The 🔵 copies are named from the bare name: a blue circle replaces a
  // yellow one rather than following it. The plain copies mirror the source,
  // yellow circle and all.
  const base = stripYellow(sourceName);
  const plain = hasYellow(sourceName) ? withYellow : (n: string) => n;
  return {
    blue: withBlue(base),
    optOut: plain(withOptOut(base)),
    blueOptOut: withOptOut(withBlue(base)),
    signature: plain(withSignature(base)),
    blueSignature: withSignature(withBlue(base)),
  };
}

/** The name with its " - Opt Out" marker taken out: "🟡 X - Opt Out (August)" → "🟡 X (August)". */
export function withoutOptOut(name: string): string {
  return name.replace(/\s*-\s*opt out(?=\s*(\(|-|$))/i, "").replace(/\s+/g, " ").trim();
}

/**
 * The copies a family has, named from its original. An original that carries
 * "Opt Out" itself was turned into Opt Out in place (Opt Out only), so its
 * family has no plain 🔵 copy and no separate Opt Out copy — just its 🔵 Opt
 * Out copy and the Signature pair: those two roles are left empty ("").
 */
export function familyNames(originalName: string): DerivedNames {
  const names = deriveNames(originalName);
  return hasOptOut(originalName) ? { ...names, blue: "", optOut: "" } : names;
}
