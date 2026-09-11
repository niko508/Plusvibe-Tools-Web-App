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
// The month sits in a trailing parenthetical and stays last, with NO separator
// introduced in front of it — the marker goes before the parenthetical, not
// after the campaign name.

export const BLUE = "🔵";
export const OPT_OUT = "Opt Out";
export const SIGNATURE = "Signature";
const SEP = " - ";

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

export function deriveNames(sourceName: string): DerivedNames {
  const base = sourceName.trim();
  return {
    blue: withBlue(base),
    optOut: withOptOut(base),
    blueOptOut: withOptOut(withBlue(base)),
    signature: withSignature(base),
    blueSignature: withSignature(withBlue(base)),
  };
}
