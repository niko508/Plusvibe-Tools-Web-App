// Derives the three campaign names this tool creates from one source name.
//
//   Tree Removal - August          (source, untouched)
//   🔵 Tree Removal - August       (Microsoft leads)
//   Tree Removal - Opt Out - August
//   🔵 Tree Removal - Opt Out - August
//
// The blue circle marks the Microsoft-only copy; "Opt Out" marks the copy whose
// step 1 carries the opt-out spintax.

export const BLUE = "🔵";
export const OPT_OUT = "Opt Out";
const SEP = " - ";

export interface DerivedNames {
  blue: string;
  optOut: string;
  blueOptOut: string;
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

/**
 * Inserts an "Opt Out" segment before the final " - " segment:
 *
 *   "Tree Removal - August"  ->  "Tree Removal - Opt Out - August"
 *
 * The trailing segment is typically a month or a batch marker, and keeping it
 * last is what makes the four campaigns sort together in Plusvibe's list. A
 * name with no separator has the segment appended instead, since there's no
 * trailing part to sit in front of:
 *
 *   "Tree Removal"  ->  "Tree Removal - Opt Out"
 *
 * The blue prefix is preserved, so this composes with withBlue() either way.
 */
export function withOptOut(name: string): string {
  const trimmed = name.trim();
  if (hasOptOut(trimmed)) return trimmed;

  const parts = trimmed.split(SEP);
  if (parts.length < 2) return `${trimmed}${SEP}${OPT_OUT}`;

  const last = parts[parts.length - 1];
  const head = parts.slice(0, -1);
  return [...head, OPT_OUT, last].join(SEP);
}

/** True if a name already carries an "Opt Out" segment (case-insensitive). */
export function hasOptOut(name: string): boolean {
  return name
    .split(SEP)
    .some((p) => p.trim().toLowerCase() === OPT_OUT.toLowerCase());
}

export function deriveNames(sourceName: string): DerivedNames {
  const base = sourceName.trim();
  return {
    blue: withBlue(base),
    optOut: withOptOut(base),
    blueOptOut: withOptOut(withBlue(base)),
  };
}
